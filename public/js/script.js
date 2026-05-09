document.addEventListener("DOMContentLoaded", async () => {
  const channelsContainer = document.getElementById("channels-list-container");
  const lastUpdatedSpan = document.getElementById("last-updated");

  let activePlayerContainer = null;
  let currentPlayerRow = null;
  let previewTimeout = null;

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

  function extractYouTubeVideoId(url) {
    if (!url) return null;
    const patterns = [
      /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([^&\?\/]+)/,
      /youtube\.com\/live\/([^&\?\/]+)/,
    ];
    for (const p of patterns) {
      const m = url.match(p);
      if (m) return m[1];
    }
    return null;
  }

  /** Attach HLS.js to a video element with error fallback to native src */
  function attachHls(video, src) {
    if (window.Hls && window.Hls.isSupported()) {
      const hls = new Hls({ lowLatencyMode: true, enableWorker: true });
      hls.loadSource(src);
      hls.attachMedia(video);
      hls.on(Hls.Events.ERROR, (_, data) => {
        if (data.fatal) {
          console.warn('HLS.js fatal error', data.type, data.details);
          hls.destroy();
          video.src = src;
          video.play().catch(() => {});
        }
      });
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = src;
    } else {
      video.src = src;
    }
  }

  function getChannelUrl(data) {
    const p = (data.platform || "").toLowerCase();
    if (p === "twitch")   return `https://twitch.tv/${data.username}`;
    if (p === "youtube")  return data.url || `https://youtube.com/@${data.username}`;
    if (p === "kick")     return `https://kick.com/${data.username}`;
    if (p === "vaughn")   return `https://vaughn.live/${data.username}`;
    if (p === "parti")    return `https://parti.com/${data.username}`;
    if (p === "rumble")   return data.url || `https://rumble.com/c/${data.username}`;
    return data.url || "#";
  }

  /** Player handling */
  function closePlayer() {
    if (activePlayerContainer) {
      const video = activePlayerContainer.querySelector("video");
      if (video && video._flvPlayer) {
        video._flvPlayer.pause();
        video._flvPlayer.unload();
        video._flvPlayer.detachMediaElement();
        video._flvPlayer.destroy();
      }
      activePlayerContainer.remove();
      activePlayerContainer = null;
      currentPlayerRow = null;
    }
  }

  function showInlinePlayer(row, data) {
    closePlayer();

    const platform = (data.platform || "").toLowerCase();
    const isOnline = data.status === "online";

    const container = document.createElement("div");
    container.className = `inline-player-container ${platform}`;
    container.innerHTML = `
      <div class="player-controls">
        <button class="close-btn">✖️</button>
      </div>
      <div class="player-body" style="height: 100%; display: flex;">Loading…</div>
    `;

    row.parentNode.insertBefore(container, row.nextSibling);
    activePlayerContainer = container;
    currentPlayerRow = row;

    const playerBody = container.querySelector(".player-body");
    const closeBtn = container.querySelector(".close-btn");

    closeBtn.onclick = (e) => {
      e.stopPropagation();
      closePlayer();
    };

    setTimeout(() => {
      playerBody.innerHTML = "";

      /** ---------- TWITCH ---------- */
      if (platform === "twitch") {
        const iframe = document.createElement("iframe");
        iframe.src = `https://player.twitch.tv/?channel=${data.username}&parent=${location.hostname}&autoplay=true&muted=false`;
        iframe.allow = "autoplay; fullscreen";
        iframe.width = "100%";
        iframe.height = "100%";
        iframe.frameBorder = "0";
        playerBody.appendChild(iframe);
      }

      /** ---------- YOUTUBE ---------- */
      else if (platform === "youtube" && isOnline && data.url) {
        const vid = extractYouTubeVideoId(data.url);
        if (vid) {
          const iframe = document.createElement("iframe");
          iframe.src = `https://www.youtube.com/embed/${vid}?autoplay=1&mute=0`;
          iframe.allow = "autoplay; encrypted-media";
          iframe.width = "100%";
          iframe.height = "100%";
          iframe.frameBorder = "0";
          playerBody.appendChild(iframe);
        }
      }

      /** ---------- RUMBLE ---------- */
      else if (platform === "rumble" && isOnline && data.url) {
        const rumbleId = data.url.match(/rumble\.com\/(v[^-\/\?]+)/)?.[1];
        const iframe = document.createElement("iframe");
        iframe.src = rumbleId
          ? `https://rumble.com/embed/${rumbleId}/?pub=0&autoplay=2`
          : data.url;
        iframe.allow = "autoplay; fullscreen";
        iframe.width = "100%";
        iframe.height = "100%";
        iframe.frameBorder = "0";
        playerBody.appendChild(iframe);
      }

      /** ---------- VAUGHN (FLV) ---------- */
      else if (platform === "vaughn" && isOnline) {
        const video = document.createElement("video");
        video.controls = true;
        video.autoplay = true;
        video.muted = false;
        video.style.width = "100%";
        video.style.height = "100%";

        const streamUrl = `https://stream-cdn-iad3.vaughnsoft.net/play/live_${data.username}.flv`;

        const FLVEngine = window.mpegjs || window.flvjs;

        if (FLVEngine && FLVEngine.isSupported()) {
          const player = FLVEngine.createPlayer({ type: 'flv', url: streamUrl });
          player.attachMediaElement(video);
          player.load();
          player.play();
          video._flvPlayer = player;
        } else {
          playerBody.innerHTML = `<div class="error" style="color:white; padding:10px;">FLV Library missing</div>`;
          return;
        }

        playerBody.appendChild(video);
      }

      /** ---------- PARTI (iframe embed) ---------- */
      else if (platform === "parti" && isOnline) {
        const iframe = document.createElement("iframe");
        iframe.src = `https://parti.com/embed/live/${data.username}`;
        iframe.allow = "autoplay; fullscreen";
        iframe.width = "100%";
        iframe.height = "100%";
        iframe.frameBorder = "0";
        playerBody.appendChild(iframe);
      }

      /** ---------- HLS STREAMS (M3U8) ---------- */
      else if (isOnline) {
        const video = document.createElement("video");
        video.controls = true;
        video.autoplay = true;
        video.muted = false;
        video.style.width = "100%";
        video.style.height = "100%";

        attachHls(video, data.m3u8);
        playerBody.appendChild(video);
      }

      /** ---------- OFFLINE VIDEO HANDLING ---------- */
      else {
        if (platform === "kick" && (data.m3u8 || data.vod_id)) {
          const kickSrc = data.m3u8 || data.vod_id;
          const video = document.createElement("video");
          video.controls = true;
          video.autoplay = true;
          video.muted = false;
          video.style.width = "100%";
          video.style.height = "100%";

          attachHls(video, kickSrc);
          playerBody.appendChild(video);
        }

        else if (platform === "twitch" && data.vod_id) {
          const iframe = document.createElement("iframe");
          iframe.src = `https://player.twitch.tv/?video=${data.vod_id}&parent=${location.hostname}&autoplay=true&muted=false`;
          iframe.allow = "autoplay; fullscreen";
          iframe.width = "100%";
          iframe.height = "100%";
          iframe.frameBorder = "0";
          playerBody.appendChild(iframe);
        }

        else if (platform === "youtube" && (data.vod_url || data.url)) {
          const targetUrl = data.vod_url || data.url;
          const vid = extractYouTubeVideoId(targetUrl);
          if (vid) {
            const iframe = document.createElement("iframe");
            iframe.src = `https://www.youtube.com/embed/${vid}?autoplay=1&mute=0`;
            iframe.allow = "autoplay; encrypted-media";
            iframe.width = "100%";
            iframe.height = "100%";
            iframe.frameBorder = "0";
            playerBody.appendChild(iframe);
          } else {
            playerBody.innerHTML = ``;
          }
        }

        else if (platform === "rumble" && data.vod_url) {
          window.open(data.vod_url, "_blank");
          closePlayer();
        }

        else {
          playerBody.innerHTML = ``;
        }
      }
    }, 100);
  }

  /** ---------- Dashboard update ---------- */
  async function updateDashboard() {
    try {
      const res = await fetch(`/api/streamers?t=${Date.now()}`);
      const { streamers = [] } = await res.json();

      if (lastUpdatedSpan) {
        lastUpdatedSpan.textContent = `Last Scraped: ${new Date().toLocaleTimeString()}`;
      }

      streamers.sort((a, b) => {
        const aOnline = a.status === "online";
        const bOnline = b.status === "online";
        if (aOnline && !bOnline) return -1;
        if (!aOnline && bOnline) return 1;
        if (aOnline && bOnline) return (b.viewers_raw ?? 0) - (a.viewers_raw ?? 0);
        return (new Date(b.last_broadcast_time || 0)) - (new Date(a.last_broadcast_time || 0));
      });

      const header = channelsContainer.querySelector(".header-row");
      channelsContainer.innerHTML = "";
      if (header) channelsContainer.appendChild(header);

      streamers.forEach((data) => {
        const isOnline = data.status === "online";
        const platform = (data.platform || "").toLowerCase();
        const displayName = (platform === "kick" || platform === "youtube" || platform === "rumble")
            ? data.display_name || data.username
            : data.username;

        const row = document.createElement("div");
        row.className = `channel ${isOnline ? "online" : "offline"} ${platform}`;
        row.innerHTML = `
          <div class="avatar">
            <span class="image" style="background-image:url('${data.photo || "/images/default-avatar.png"}')"></span>
          </div>
          <div class="details">
            <div class="name">
              <span class="user-main-name">${displayName}</span>
              ${isOnline && data.title ? `<span class="stream-title">${data.title}</span>` : ""}
            </div>
            <div class="status">
              <span>${isOnline ? formatNumber(data.viewers_raw ?? 0) : formatRelativeTime(data.last_broadcast_time)}</span>
              ${isOnline ? `<span class="dot"></span>` : ""}
            </div>
          </div>
        `;

        row.onclick = () => {
          if (!isOnline && data.vod_url && (platform === "rumble" || platform === "youtube")) {
            window.open(data.vod_url, "_blank");
          } else if (platform === "youtube" && data.url) {
            window.open(data.url, "_blank");
          } else {
            window.open(getChannelUrl(data), "_blank");
          }
        };

        row.onmouseenter = () => {
          if (previewTimeout) clearTimeout(previewTimeout);
          previewTimeout = setTimeout(() => showInlinePlayer(row, data), 200);
        };

        row.onmouseleave = (e) => {
          if (previewTimeout) clearTimeout(previewTimeout);
          setTimeout(() => {
            const hovered = document.querySelectorAll(':hover');
            const isHoveringPlayer = Array.from(hovered).some(el => el.classList.contains('inline-player-container'));
            if (!isHoveringPlayer) closePlayer();
          }, 100);
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