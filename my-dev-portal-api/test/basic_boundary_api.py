"""Opt-in real API/PG bridge for the portal's Stripe boundary integration test."""

import importlib.util
import json
import os
from pathlib import Path
import sys
from datetime import datetime, timedelta, timezone

root = Path(os.environ["SN_PREPAID_TEST_API_ROOT"]).resolve()
sys.path.insert(0, str(root))
spec = importlib.util.spec_from_file_location(
    "isolated_api_fixtures", root / "tests/prepaid/conftest.py"
)
fixtures = importlib.util.module_from_spec(spec)
# The API fixture validates the loopback-only DSN and disables dotenv before
# importing any app code. Its schema is unique and removed on exit.
spec.loader.exec_module(fixtures)

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from app.api.api_v3.endpoints import developer_portal, prepaid
from app.models.auth import (
    AuthOrganization,
    BillingCredit,
    BillingPlanChange,
    BillingSubscription,
)
from app.schemas.developer_portal import PlanChangeResponse

patch = pytest.MonkeyPatch()
database = fixtures.factory.__wrapped__(patch)
factory = next(database)
account = fixtures.account.__wrapped__(factory)
app = FastAPI()
app.include_router(prepaid.router, prefix="/api/v3/developer-portal")
app.include_router(developer_portal.router, prefix="/api/v3/developer-portal")


def initialize(plan):
    assert plan in {"growth", "enterprise"}
    end = datetime.now(timezone.utc) + timedelta(minutes=5)
    with factory() as db:
        organization = db.get(AuthOrganization, account["organization_id"])
        organization.plan_key = plan
        organization.stripe_customer_id = "cus_boundary"
        organization.current_subscription_id = "sub_boundary"
        organization.billing_status = "active"
        organization.moesif_company_id = str(organization.id)
        db.add(
            BillingSubscription(
                organization_id=organization.id,
                user_id=account["user_id"],
                provider_subscription_id="sub_boundary",
                stripe_subscription_id="sub_boundary",
                stripe_customer_id="cus_boundary",
                billing_provider="stripe",
                debit_owner="admin",
                plan_key=plan,
                status="active",
                is_current=True,
                current_period_start=(end - timedelta(days=30)).replace(tzinfo=None),
                current_period_end=end.replace(tzinfo=None),
            )
        )
        for source, subscription, amount in [
            ("legacy", "sub_boundary", 12345),
            ("development_grant", "prepaid_historical_dev", 4567),
        ]:
            db.add(
                BillingCredit(
                    organization_id=organization.id,
                    subscription_id=subscription,
                    source_reference="fixture:" + source,
                    source_type=source,
                    amount_gbp_pence=amount,
                    remaining_gbp_pence=amount,
                )
            )
        db.commit()
    return {**account, "end": end.isoformat()}


def advance_boundary(request_id):
    with factory() as db:
        change = db.query(BillingPlanChange).filter_by(request_id=request_id).one()
        boundary = datetime.now(timezone.utc) - timedelta(days=1)
        change.effective_at = boundary
        change.commitment_ends_at = boundary
        # Existing Stripe provisioning stores monthly metered periods, which
        # may precede the persisted annual boundary when a webhook was missed.
        source = db.query(BillingSubscription).filter_by(is_current=True).one()
        source.current_period_end = (boundary - timedelta(days=30)).replace(tzinfo=None)
        db.commit()
        return PlanChangeResponse.model_validate(change).model_dump(mode="json")


def inspect_state():
    with factory() as db:
        organization = db.get(AuthOrganization, account["organization_id"])
        return {
            "plan": organization.plan_key,
            "subscription": organization.current_subscription_id,
            "credits": [
                {
                    "source": row.source_type,
                    "remaining": row.remaining_gbp_pence,
                    "subscription": row.subscription_id,
                }
                for row in db.query(BillingCredit).order_by(BillingCredit.id)
            ],
            "statuses": [row.status for row in db.query(BillingPlanChange)],
        }


def replace_with_newer_plan():
    with factory() as db:
        organization = db.get(AuthOrganization, account["organization_id"])
        current = db.query(BillingSubscription).filter_by(is_current=True).one()
        current.is_current = False
        current.status = "superseded"
        db.flush()
        db.add(
            BillingSubscription(
                organization_id=organization.id,
                user_id=account["user_id"],
                provider_subscription_id="sub_newer",
                stripe_subscription_id="sub_newer",
                stripe_customer_id="cus_boundary",
                billing_provider="stripe",
                debit_owner="admin",
                plan_key="enterprise",
                status="active",
                is_current=True,
            )
        )
        organization.plan_key = "enterprise"
        organization.current_subscription_id = "sub_newer"
        db.commit()
    return inspect_state()


try:
    with TestClient(app) as client:
        for line in sys.stdin:
            request = json.loads(line)
            try:
                action = request["action"]
                if action == "initialize":
                    result = initialize(request["plan"])
                elif action == "advance":
                    result = advance_boundary(request["request_id"])
                elif action == "inspect":
                    result = inspect_state()
                elif action == "replace":
                    result = replace_with_newer_plan()
                elif action == "http":
                    response = client.request(
                        request["method"],
                        request["path"],
                        headers=request["headers"],
                        content=request.get("body"),
                    )
                    result = {"status": response.status_code, "body": response.json()}
                else:
                    raise ValueError("Unknown bridge action")
                print(json.dumps({"id": request["id"], "result": result}), flush=True)
            except Exception as error:
                print(
                    json.dumps({"id": request["id"], "error": type(error).__name__}),
                    flush=True,
                )
finally:
    database.close()
    patch.undo()
