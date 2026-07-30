import { apiRequest } from "../../../lib/portal-api";

function customizeUrlDisplayOptions(embedInfo) {
  const displayOptions = {
    embed: true,
    hide_header: true,
    show_daterange: true,
    primary_color: "#1b6b4f",
  };
  return `https://www.moesif.com/public/em/ws/${
    embedInfo._id
  }?${new URLSearchParams(displayOptions).toString()}#${embedInfo.token}`;
}

export default async function fetchEmbedChartUrls({ idToken }) {
  const embedInfoArray = await apiRequest("/embed-charts", idToken);
  return Array.isArray(embedInfoArray)
    ? embedInfoArray.map(customizeUrlDisplayOptions)
    : [];
}
