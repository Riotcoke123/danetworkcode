document.addEventListener("DOMContentLoaded", async () => {
  const channelsContainer = document.getElementById("channels-list-container");
  const lastUpdatedSpan = document.getElementById("last-updated");

  /** Utility functions */
  function formatNumber(num) {
    if (num == null || isNaN(num)) return "0";
    return num.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  }

  function formatRelativeTime(isoString) {
    if (!isoString) return "TBA";
    const date = new Date(isoString);
    if (isNaN(date.getTime())) return "TBA";
    let diff = Math.floor((Date.now() - date.getTime()) / 1000);
    if (diff < 0) diff = 0;
    if (diff < 5) return "Just now";
    const units = [
      { label: "Year", seconds: 31536000 },
      { label: "Month", seconds: 2592000 },
      { label: "Day", seconds: 86400 },
      { label: "Hour", seconds: 3600 },
      { label: "Minute", seconds: 60 },
    ];
    for (const u of units) {
      const val = Math.floor(diff / u.seconds);
      if (val >= 1) return `${val} ${u.label}${val !== 1 ? "s" : ""} ago`;
    }
    return "Just now";
  }

  function getChannelUrl(data) {
    const p = (data.platform || "").toLowerCase();
    if (p === "twitch")   return `https://twitch.tv/${data.username}`;
    if (p === "youtube")  return data.url || `https://youtube.com/@${data.username}`;
    if (p === "kick")     return `https://kick.com/${data.username}`;
    if (p === "vaughn")   return `https://vaughn.live/${data.username}`;
    if (p === "parti")    return `https://parti.com/${data.username}`;
    if (p === "rumble")   return data.url || `https://rumble.com/c/${data.username}`;
    if (p === "pumpfun")  return data.url || `https://pump.fun/coin/${data.username}`;
    return data.url || "#";
  }

  /** ---------- Dashboard update ---------- */
  async function updateDashboard() {
    try {
      const res = await fetch(`/api/streamers?t=${Date.now()}`);
      const { streamers = [] } = await res.json();

      if (lastUpdatedSpan) {
        lastUpdatedSpan.textContent = `Last Scraped: ${new Date().toLocaleTimeString()}`;
      }

      // Sort order: online → premiere → offline
      // Within each tier: higher viewers first; offline: most recent broadcast first
      streamers.sort((a, b) => {
        const rank = s => s === "online" ? 0 : s === "premiere" ? 1 : 2;
        const ra = rank(a.status), rb = rank(b.status);
        if (ra !== rb) return ra - rb;
        if (ra <= 1) return (b.viewers_raw ?? 0) - (a.viewers_raw ?? 0);
        return (new Date(b.last_broadcast_time || 0)) - (new Date(a.last_broadcast_time || 0));
      });

      const header = channelsContainer.querySelector(".header-row");
      channelsContainer.innerHTML = "";
      if (header) channelsContainer.appendChild(header);

      streamers.forEach((data) => {
        const isOnline   = data.status === "online";
        const isPremiere = data.status === "premiere";
        const isActive   = isOnline || isPremiere;
        const platform   = (data.platform || "").toLowerCase();
        const displayName = (platform === "kick" || platform === "youtube" || platform === "rumble" || platform === "pumpfun")
            ? data.display_name || data.username
            : data.username;

        const row = document.createElement("div");
        row.className = `channel ${isOnline ? "online" : isPremiere ? "premiere" : "offline"} ${platform}`;
        row.innerHTML = `
          <div class="avatar">
            <span class="image" style="background-image:url('${data.photo || "/images/default-avatar.png"}')"></span>
          </div>
          <div class="details">
            <div class="name">
              <span class="user-main-name">${displayName}</span>
              ${isActive && data.title ? `<span class="stream-title">${data.title}</span>` : ""}
            </div>
            <div class="status">
              ${isPremiere ? `<span class="premiere-badge">PREMIERE</span>` : ""}
              <span>${isActive ? formatNumber(data.viewers_raw ?? 0) : formatRelativeTime(data.last_broadcast_time)}</span>
              ${isOnline   ? `<span class="dot"></span>` : ""}
              ${isPremiere ? `<span class="dot premiere-dot"></span>` : ""}
            </div>
          </div>
        `;

        row.onclick = () => {
          if (!isActive && data.vod_url && (platform === "rumble" || platform === "youtube")) {
            window.open(data.vod_url, "_blank");
          } else if (platform === "youtube" && data.url) {
            window.open(data.url, "_blank");
          } else {
            window.open(getChannelUrl(data), "_blank");
          }
        };

        channelsContainer.appendChild(row);
      });
    } catch (err) {
      console.error("Error updating dashboard:", err);
    }
  }

  updateDashboard();
  setInterval(updateDashboard, 70000);
});