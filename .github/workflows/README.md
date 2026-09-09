# Developer Portal Delivery

GitHub Actions performs CI only:

- `frontend-ci.yml` installs, lints, unit-tests, and builds `my-dev-portal`.
- `api-ci.yml` runs the API test suite and verifies its Docker image builds.

Neither workflow has AWS credentials or deploy permissions.

AWS owns deployment:

- Amplify continues to build and deploy the frontend from its connected GitHub branch.
- CodePipeline watches `develop`, `staging`, and `main` through AWS CodeConnections.
- CodeBuild uses `buildspec-api.yml` to build and push the API image to ECR.
- CodePipeline deploys the generated image definition to the matching ECS service.

| Branch | Environment | API service |
| --- | --- | --- |
| `develop` | dev | `moesif-developer-portal-dev` |
| `staging` | staging | `moesif-developer-portal-staging` |
| `main` | production | `moesif-developer-portal-prod` |
