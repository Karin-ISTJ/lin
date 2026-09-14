(function () {
  /* 启动时强制关闭全屏应用层，避免透明遮罩挡住主屏触摸 */
  (function resetOverlayApps() {
    document.body.classList.remove('miya-app-open');
    document.querySelectorAll(
      '.miya-beautify-app, .miya-settings-app, .miya-worldbook-app, .miya-contacts-app, #miya-chat-app, #miya-memory-app, #miya-st-presets-app, #miya-diary-app, #miya-offline-app, #miya-itinerary-app, #miya-couple-app, #miya-fun-app, #miya-fun-sayguess'
    ).forEach(function (el) {
      if (!el.classList.contains('is-open')) {
        el.setAttribute('hidden', '');
        el.setAttribute('aria-hidden', 'true');
      }
    });
  })();

  var S = 'rgba(70,74,80,0.82)';
  var L = 'rgba(130,136,145,0.65)';

  var SVG_CLASSIC = {
    set: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M19.14 12.94c.04-.31.06-.63.06-.94 0-.31-.02-.63-.06-.94l2.03-1.58a.49.49 0 00.12-.61l-1.92-3.32a.488.488 0 00-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.484.484 0 00-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.04.31-.06.63-.06.94s.02.63.06.94l-2.03 1.58a.49.49 0 00-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"/></svg>',
    book: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M6.5 2H20v20H6.5A2.5 2.5 0 014 19.5v-15A2.5 2.5 0 016.5 2zm0 2A.5.5 0 006 4.5v15a.5.5 0 00.5.5H18V4H6.5zM8 7h8v2H8V7zm0 4h6v2H8v-2z"/></svg>',
    memory: '<svg viewBox="0 0 24 24" fill="none"><path d="M9 18h6M10 22h4M12 2a6 6 0 00-4 10.5V16h8v-3.5A6 6 0 0012 2z" stroke="rgba(70,74,80,0.82)" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    chat: '<svg viewBox="0 0 24 24" fill="none"><path d="M4 6h16v10H7l-3 3V6z" stroke="rgba(70,74,80,0.82)" stroke-width="1.2" stroke-linejoin="round"/><path d="M8 11h8" stroke="rgba(130,136,145,0.65)" stroke-width="1.1" stroke-linecap="round"/></svg>',
    board: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z"/></svg>',
    play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>',
    beauty: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 3c-4.97 0-9 4.03-9 9s4.03 9 9 9c.83 0 1.5-.67 1.5-1.5 0-.39-.15-.74-.39-1.01-.23-.26-.38-.61-.38-.99 0-.83.67-1.5 1.5-1.5H16c2.76 0 5-2.24 5-5 0-4.42-4.03-8-9-8zm-5.5 9c-.83 0-1.5-.67-1.5-1.5S5.67 9 6.5 9 8 9.67 8 10.5 7.33 12 6.5 12zm3-4C8.67 8 8 7.33 8 6.5S8.67 5 9.5 5s1.5.67 1.5 1.5S10.33 8 9.5 8zm5 0c-.83 0-1.5-.67-1.5-1.5S13.67 5 14.5 5s1.5.67 1.5 1.5S15.33 8 14.5 8zm3 4c-.83 0-1.5-.67-1.5-1.5S16.67 9 17.5 9s1.5.67 1.5 1.5-.67 1.5-1.5 1.5z"/></svg>',
    store: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M20 4H4v2h16V4zm1 10v-2l-1-5H4l-1 5v2h1v6h10v-6h4v6h2v-6h1zm-9 4H6v-4h6v4z"/></svg>',
    photo: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M21 19V5c0-1.1-.9-2-2-2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2zM8.5 13.5l2.5 3.01L14.5 12l4.5 6H5l3.5-4.5z"/></svg>',
    world: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z"/></svg>',
    phone: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M6.62 10.79c1.44 2.83 3.76 5.14 6.59 6.59l2.2-2.2c.27-.27.67-.36 1.02-.24 1.12.37 2.33.57 3.57.57.55 0 1 .45 1 1V20c0 .55-.45 1-1 1-9.39 0-17-7.61-17-17 0-.55.45-1 1-1h3.5c.55 0 1 .45 1 1 0 1.25.2 2.45.57 3.57.11.35.03.74-.25 1.02l-2.2 2.2z"/></svg>',
    contacts: '<svg viewBox="0 0 24 24" fill="none"><circle cx="9" cy="8" r="3" stroke="rgba(70,74,80,0.82)" stroke-width="1.2"/><path d="M3 20c0-3.3 2.7-6 6-6" stroke="rgba(130,136,145,0.65)" stroke-width="1.1" stroke-linecap="round"/><circle cx="17" cy="9" r="2.5" stroke="rgba(70,74,80,0.82)" stroke-width="1.1"/><path d="M14 20c.5-2.2 2-3.5 4-3.5s3.5 1.3 4 3.5" stroke="rgba(130,136,145,0.65)" stroke-width="1.1" stroke-linecap="round"/></svg>',
    pen: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2c-1.1 0-2 .9-2 2v2h4V4c0-1.1-.9-2-2-2zm6 6H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm-6 11c-1.66 0-3-1.34-3-3s1.34-3 3-3 3 1.34 3 3-1.34 3-3 3z"/></svg>',
    couple: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>',
    itinerary: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z"/></svg>',
    notes: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M14 2H6c-1.1 0-1.99.9-1.99 2L4 20c0 1.1.89 2 1.99 2H18c1.1 0 2-.9 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z"/></svg>',
    fun: '<svg viewBox="0 0 24 24" fill="none"><rect x="2" y="6" width="20" height="12" rx="2" stroke="rgba(70,74,80,0.82)" stroke-width="1.2"/><path d="M6 12h4M14 10v4M17 10v4" stroke="rgba(130,136,145,0.65)" stroke-width="1.2" stroke-linecap="round"/><circle cx="8" cy="12" r="1" fill="rgba(130,136,145,0.65)"/></svg>',
    imagegen: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M21 19V5c0-1.1-.9-2-2-2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2zM8.5 13.5l2.5 3.01L14.5 12l4.5 6H5l3.5-4.5z"/><path d="M19 2l.7 1.7L21.4 4.4 19.7 5.1 19 6.8l-.7-1.7L16.6 4.4l1.7-.7z"/></svg>',
    log: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M19 3h-1V1h-2v2H8V1H6v2H5c-1.11 0-1.99.9-1.99 2L3 19c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 16H5V8h14v11zM9 10H7v2h2v-2zm4 0h-2v2h2v-2zm4 0h-2v2h2v-2z"/></svg>',
    weather: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M19.35 10.04C18.67 6.59 15.64 4 12 4 9.11 4 6.6 5.64 5.35 8.04 2.34 8.36 0 10.91 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96z"/></svg>',
    apps: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M4 8h4V4H4v4zm6 12h4v-4h-4v4zm-6 0h4v-4H4v4zm0-6h4v-4H4v4zm6 0h4v-4h-4v4zm6-10v4h4V4h-4zm-6 4h4V4h-4v4zm6 6h4v-4h-4v4zm0 6h4v-4h-4v4z"/></svg>',
  };

  var SVG_ENT = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M17 4H7C4.24 4 2 6.24 2 9v7.88a3.124 3.124 0 0 0 5.33 2.21l1.96-1.96c.71-.71 1.7-1.12 2.71-1.12s1.99.41 2.71 1.12l1.96 1.96A3.124 3.124 0 0 0 22 16.88V9c0-2.76-2.24-5-5-5M7 12c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2m9.5-5c.55 0 1 .45 1 1s-.45 1-1 1-1-.45-1-1 .45-1 1-1m-2 4c-.55 0-1-.45-1-1s.45-1 1-1 1 .45 1 1-.45 1-1 1m2 2c-.55 0-1-.45-1-1s.45-1 1-1 1 .45 1 1-.45 1-1 1m2-2c-.55 0-1-.45-1-1s.45-1 1-1 1 .45 1 1-.45 1-1 1"></path></svg>';

  var SVG_ALT = {
    book: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M20 2H6C4.35 2 3 3.35 3 5v14c0 1.65 1.35 3 3 3h15v-2H6c-.55 0-1-.45-1-1s.45-1 1-1h14c.55 0 1-.45 1-1V3c0-.55-.45-1-1-1m-3 6H8V6h9z"></path></svg>',
    memory: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 22h12c1.1 0 2-.9 2-2V6c0-.27-.11-.52-.29-.71l-3-3A1 1 0 0 0 16 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2m7-17h2v4h-2zm-3 0h2v4h-2zM7 5h2v4H7z"></path></svg>',
    chat: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M20 3H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h3v2c0 .36.19.69.51.87.15.09.32.13.49.13s.36-.05.51-.14L13.27 19h6.72c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2Zm-4.65 8.21L12 14.5l-3.35-3.29-.06-.06c-.82-.85-.79-2.2.06-3.01.87-.86 2.26-.86 3.12 0l.22.22.22-.22c.87-.86 2.26-.86 3.12 0l.06.06c.82.85.79 2.2-.06 3.01Z"></path></svg>',
    board: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M20.93 3.07c-1.27-1.27-3.42-1.42-6.06-.4-.94.36-1.9.86-2.87 1.46-.97-.61-1.93-1.1-2.87-1.46-2.63-1.01-4.79-.87-6.06.4C1.28 4.86 1.8 8.31 4.12 12c-2.32 3.69-2.84 7.14-1.05 8.93.71.71 1.7 1.07 2.89 1.07.94 0 2.01-.22 3.17-.67.94-.36 1.9-.86 2.87-1.46.97.61 1.93 1.1 2.87 1.46 1.16.45 2.23.67 3.17.67 1.19 0 2.18-.36 2.89-1.07 1.79-1.79 1.27-5.24-1.05-8.93 2.32-3.69 2.84-7.14 1.05-8.93M4.48 4.48C4.8 4.16 5.31 4 5.97 4c.68 0 1.52.18 2.44.53.58.22 1.18.51 1.79.85-.87.67-1.74 1.43-2.56 2.25-.84.84-1.58 1.69-2.25 2.55-1.45-2.6-1.79-4.82-.91-5.7M12 6.54c1 .72 2 1.56 2.95 2.51.97.97 1.8 1.97 2.5 2.95-.7.98-1.53 1.97-2.5 2.95C14 15.9 13 16.74 12 17.46c-1-.72-2-1.56-2.95-2.51-.97-.97-1.8-1.97-2.5-2.95.7-.98 1.53-1.97 2.5-2.95C10 8.1 11 7.26 12 6.54M8.41 19.46c-1.8.69-3.27.71-3.93.05-.88-.88-.54-3.1.91-5.7.66.85 1.41 1.71 2.25 2.55a25 25 0 0 0 2.56 2.25c-.61.34-1.2.63-1.79.85m11.1.05c-.66.66-2.13.64-3.93-.05-.58-.22-1.18-.51-1.79-.85.87-.67 1.74-1.43 2.56-2.25.84-.84 1.58-1.69 2.25-2.55 1.45 2.6 1.79 4.82.91 5.7m-.91-9.33c-.66-.85-1.41-1.71-2.25-2.55a25 25 0 0 0-2.56-2.25c.61-.34 1.2-.63 1.79-.85.92-.35 1.76-.53 2.44-.53s1.16.16 1.49.48c.88.88.54 3.1-.91 5.7"></path><path d="M13.77 13.77c.98-.98.98-2.56 0-3.54s-2.56-.98-3.54 0-.98 2.56 0 3.54 2.56.98 3.54 0"></path></svg>',
    play: SVG_ENT,
    beauty: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M16.41 10.41a.998.998 0 0 0 0-1.82l-4.15-1.84-1.84-4.15a.99.99 0 0 0-.91-.59c-.39 0-.74.23-.91.58L6.75 6.6 2.57 8.61c-.35.17-.57.53-.57.92s.24.74.59.9l4.15 1.84 1.84 4.15a.998.998 0 0 0 1.82 0l1.84-4.15 4.15-1.84Zm5.19 5.98-2.77-1.23-1.23-2.77a.68.68 0 0 0-.6-.4c-.27-.02-.5.15-.61.39l-1.23 2.67-2.78 1.34c-.23.11-.38.35-.38.61s.16.49.4.6l2.77 1.23 1.23 2.77a.663.663 0 0 0 1.22 0l1.23-2.77 2.77-1.23c.24-.11.4-.35.4-.61s-.16-.5-.4-.61ZM7.76 18.63l-1.66-.74-.74-1.66a.41.41 0 0 0-.36-.24c-.16-.01-.3.09-.37.23l-.74 1.6-1.67.8c-.14.07-.23.21-.23.37s.1.3.24.36l1.66.74.74 1.66a.404.404 0 0 0 .74 0l.74-1.66 1.66-.74a.404.404 0 0 0 0-.74Z"></path></svg>',
    store: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="m20.2 4.02-10-2c-.29-.06-.6.02-.83.21S9 2.7 9 3v1H4c-.55 0-1 .45-1 1v14c0 .55.45 1 1 1h5v1c0 .3.13.58.37.77.18.15.4.23.63.23.07 0 .13 0 .2-.02l10-2c.47-.09.8-.5.8-.98V5c0-.48-.34-.89-.8-.98M5 18V6h4v12zm8-5c-.55 0-1-.45-1-1s.45-1 1-1 1 .45 1 1-.45 1-1 1"></path></svg>',
    photo: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M20 2H4c-1.1 0-2 .9-2 2v4c0 1.01.39 1.91 1 2.62V20c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2v-9.38c.61-.7 1-1.61 1-2.62V4c0-1.1-.9-2-2-2M8 8c0 1.1-.9 2-2 2s-2-.9-2-2V4h4zm2-4h4v4c0 1.1-.9 2-2 2s-2-.9-2-2zm5 16H9v-5c0-.55.45-1 1-1h4c.55 0 1 .45 1 1zm5-12c0 1.1-.9 2-2 2s-2-.9-2-2V4h4z"></path></svg>',
    world: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M20 2H6C4.35 2 3 3.35 3 5v14c0 1.65 1.35 3 3 3h15v-2H6c-.55 0-1-.45-1-1s.45-1 1-1h14c.55 0 1-.45 1-1V3c0-.55-.45-1-1-1m-3 6H8V6h9z"></path></svg>',
    phone: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M19 2H5c-.55 0-1 .45-1 1v4H2v2h2v2H2v2h2v2H2v2h2v4c0 .55.45 1 1 1h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2m-6.5 5C13.93 7 15 8.07 15 9.5S13.93 12 12.5 12 10 10.93 10 9.5 11.07 7 12.5 7M17 17H8v-1c0-1.66 1.34-3 3-3h3c1.66 0 3 1.34 3 3z"></path></svg>',
    contacts: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M19 2H5c-.55 0-1 .45-1 1v4H2v2h2v2H2v2h2v2H2v2h2v4c0 .55.45 1 1 1h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2m-6.5 5C13.93 7 15 8.07 15 9.5S13.93 12 12.5 12 10 10.93 10 9.5 11.07 7 12.5 7M17 17H8v-1c0-1.66 1.34-3 3-3h3c1.66 0 3 1.34 3 3z"></path></svg>',
    pen: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="m22 2-2 2h-6l-2-2v7c0 2.76 2.24 5 5 5s5-2.24 5-5V4h-.01V2Zm-7 7c-.55 0-1-.45-1-1s.45-1 1-1 1 .45 1 1-.45 1-1 1m4 0c-.55 0-1-.45-1-1s.45-1 1-1 1 .45 1 1-.45 1-1 1"></path><path d="M11.09 10H5.5C4.67 10 4 9.33 4 8.5S4.67 7 5.5 7C7.06 7 10 6.16 10 3V2H8v1c0 1.88-2.09 2-2.5 2C3.57 5 2 6.57 2 8.5c0 1.42.85 2.63 2.06 3.18L5 21.1a1 1 0 0 0 1 .9h3c.55 0 1-.45 1-1v-3h4v3c0 .55.45 1 1 1h3c.51 0 .94-.38.99-.89l.75-6.78c-.82.43-1.76.67-2.75.67-2.97 0-5.43-2.17-5.91-5Z"></path></svg>',
    couple: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M5 5a2 2 0 1 0 0 4 2 2 0 1 0 0-4m14.5 5h-.7c-.84 0-1.61.42-2.08 1.11L13.46 16h-2.93l-3.26-4.89C6.81 10.41 6.03 10 5.19 10h-.7a2.5 2.5 0 0 0-2.5 2.5V18h5v-3.7l1.87 2.81c.37.56.99.89 1.66.89h2.93c.67 0 1.29-.33 1.66-.89l1.87-2.81V18h5v-5.5a2.5 2.5 0 0 0-2.5-2.5ZM19 5a2 2 0 1 0 0 4 2 2 0 1 0 0-4"></path><path d="M14.51 10.17c.65-.67.65-1.74 0-2.41-.66-.67-1.69-.67-2.34 0l-.17.17-.17-.17c-.65-.67-1.69-.67-2.34 0-.65.68-.65 1.74 0 2.41L12 12.75z"></path></svg>',
    itinerary: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M19.17 5.11A2 2 0 0 0 17.38 4H4c-1.1 0-2 .9-2 2v9c0 1.1.9 2 2 2 0 1.65 1.35 3 3 3s3-1.35 3-3h4c0 1.65 1.35 3 3 3s3-1.35 3-3c1.1 0 2-.9 2-2v-3.76c0-.31-.07-.62-.21-.89zM17.38 6l.89.45L20 10h-4.13V6zm-4.13 0v4h-3.5V6zm-5.5 0v4H4V6zM7 18a1.003 1.003 0 0 1-.87-1.5c.36-.62 1.33-.63 1.72-.02A.95.95 0 0 1 8 17c0 .55-.45 1-1 1m10 0a1.003 1.003 0 0 1-.87-1.5c.36-.62 1.33-.63 1.72-.02A.95.95 0 0 1 18 17c0 .55-.45 1-1 1"></path></svg>',
    notes: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M4 21c.08 0 .16 0 .24-.03l4-1c.18-.04.34-.13.46-.26L20.99 7.42c.78-.78.78-2.05 0-2.83L19.4 3c-.78-.78-2.05-.78-2.83 0l-2.09 2.09-1.79-1.79a.996.996 0 0 0-1.41 0l-6 6 1.41 1.41 5.29-5.29 1.09 1.09-8.78 8.78c-.13.13-.22.29-.26.46l-1 4c-.09.34.01.7.26.95.19.19.45.29.71.29ZM18 4.41l1.59 1.58-2.09 2.09-1.59-1.59L18 4.4Z"></path></svg>',
    fun: SVG_ENT,
    imagegen: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M19.6 4.6H4.4A2.4 2.4 0 0 0 2 7v10a2.4 2.4 0 0 0 2.4 2.4h15.2A2.4 2.4 0 0 0 22 17V7a2.4 2.4 0 0 0-2.4-2.4M8.5 7.9a1.85 1.85 0 1 1 0 3.7 1.85 1.85 0 0 1 0-3.7m10.9 9.5H4.6l3.5-4.1c.2-.23.55-.26.78-.06l2.9 2.42 4-3.5a.53.53 0 0 1 .71.03l3.9 3.8c.2.2.3.46.3.73 0 .61-.5 1.1-1.1 1.1"></path><path d="M19 1.1l.62 1.48 1.48.62-1.48.62-.62 1.48-.62-1.48-1.48-.62 1.48-.62z"></path></svg>',
    log: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M19 4h-2V2h-2v2H9V2H7v2H5c-1.1 0-2 .9-2 2v1h18V6c0-1.1-.9-2-2-2M3 20c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V8H3zm4-8h10v2H7zm0 4h7v2H7z"></path></svg>',
    weather: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 7c-2.97 0-5.43 2.17-5.91 5H2v2h20v-2h-4.09c-.48-2.83-2.94-5-5.91-5m0 2c1.86 0 3.41 1.28 3.86 3H8.14c.45-1.72 2-3 3.86-3m-1-7h2v3h-2zm6.71 5.71 1-1 1-1L19 5l-.71-.71-1 1-1 1L17 7zm-11.42 0L7 7l.71-.71-1-1-1-1L5 5l-.71.71 1 1zM9 16h11v2H9zm-5 0h3v2H4zm2 4h10v2H6z"></path></svg>',
    apps: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M18 10c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4v2h-4V6c0-2.21-1.79-4-4-4S2 3.79 2 6s1.79 4 4 4h2v4H6c-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4v-2h4v2c0 2.21 1.79 4 4 4s4-1.79 4-4-1.79-4-4-4h-2v-4zm-2-4c0-1.1.9-2 2-2s2 .9 2 2-.9 2-2 2h-2zM8 18c0 1.1-.9 2-2 2s-2-.9-2-2 .9-2 2-2h2zM8 8H6c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2zm6 6h-4v-4h4zm4 2c1.1 0 2 .9 2 2s-.9 2-2 2-2-.9-2-2v-2z"></path></svg>',
  };

  var SVG = SVG_CLASSIC;
  if (SVG_CLASSIC.book) SVG_CLASSIC.stpreset = SVG_CLASSIC.book;
  if (SVG_ALT && SVG_ALT.book) SVG_ALT.stpreset = SVG_ALT.book;

  var NAMES = {
    set: '设置', book: '世界书',
    beauty: '美化', store: '线下', photo: '多相', world: '世界',
    phone: '电话', contacts: '联系人', pen: '模拟器',
    notes: '日记', fun: '娱乐', log: '记录', imagegen: '生图',
    couple: '情侣空间', itinerary: '行程轨迹',
  };

  var WD = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];

  function pad(n) { return n < 10 ? '0' + n : '' + n; }

  function tick() {
    var clock = document.getElementById('hero-clock');
    var meta = document.getElementById('hero-meta');
    if (!clock || !meta) return;
    var d = new Date();
    var t = pad(d.getHours()) + ':' + pad(d.getMinutes());
    clock.textContent = t;
    meta.textContent =
      (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + WD[d.getDay()] + ' · 多云 19°C';
  }

  if (document.getElementById('hero-clock')) {
    tick();
    setInterval(tick, 10000);
  }

  document.querySelectorAll('[data-i]').forEach(function (el) {
    var k = el.getAttribute('data-i');
    if (SVG[k]) el.innerHTML = SVG[k];
  });

  function getActiveAppSvgPack() {
    return document.documentElement.classList.contains('miya-alt-app-icons')
      ? Object.assign({}, SVG_CLASSIC, SVG_ALT)
      : SVG_CLASSIC;
  }

  function fillAppIcons(root) {
    var pack = getActiveAppSvgPack();
    var scope = root || document;
    scope.querySelectorAll('[data-i]').forEach(function (el) {
      var k = el.getAttribute('data-i');
      if (pack[k]) el.innerHTML = pack[k];
    });
    window.miyaAppSvg = pack;
  }

  function syncAppIconStyle(on) {
    document.documentElement.classList.toggle('miya-alt-app-icons', !!on);
    fillAppIcons();
  }

  window.miyaFillAppIcons = fillAppIcons;
  window.miyaSyncAppIconStyle = syncAppIconStyle;
  window.miyaAppSvg = SVG_CLASSIC;

  document.addEventListener('visibilitychange', function () {
    document.documentElement.classList.toggle('miya-tab-hidden', document.hidden);
  });

  (function initP2Meta() {
    var el = document.getElementById('p2-log-date');
    if (!el) return;
    function sync() {
      var d = new Date();
      el.textContent = pad(d.getMonth() + 1) + '.' + pad(d.getDate());
    }
    sync();
    setInterval(sync, 60000);
  })();

  (function initLedgerWidget() {
    var dayEl = document.getElementById('ledger-day');
    var monEl = document.getElementById('ledger-mon');
    var dowEl = document.getElementById('ledger-dow');
    var serialEl = document.getElementById('ledger-serial');
    var rowD1 = document.getElementById('ledger-row-d1');
    if (!dayEl) return;

    var MON = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

    function sync() {
      var d = new Date();
      dayEl.textContent = pad(d.getDate());
      if (monEl) monEl.textContent = MON[d.getMonth()];
      if (dowEl) dowEl.textContent = WD[d.getDay()];
      if (serialEl) {
        serialEl.textContent = '№ ' + d.getFullYear() + '·' + pad(d.getMonth() + 1);
      }
      if (rowD1) rowD1.textContent = pad(d.getDate());
    }

    sync();
    setInterval(sync, 60000);
  })();

  (function initP2Scrapbook() {
    var dayEl = document.getElementById('p2f-date-day');
    var metaEl = document.getElementById('p2f-date-meta');
    var DOW = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
    var MON = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

    function syncDate() {
      var now = new Date();
      if (dayEl) dayEl.textContent = String(now.getDate()).padStart(2, '0');
      if (metaEl) metaEl.textContent = MON[now.getMonth()] + ' · ' + DOW[now.getDay()];
    }

    syncDate();
    setInterval(syncDate, 60000);

    document.querySelectorAll('[data-p2f-flip]').forEach(function (card) {
      card.addEventListener('click', function (e) {
        if (e.target.closest('[data-miya-copy]')) return;
        card.classList.toggle('is-flipped');
      });
      card.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          card.classList.toggle('is-flipped');
        }
      });
    });

    var viewport = document.getElementById('p2f-reel-viewport');
    var track = document.getElementById('p2f-reel-track');
    if (!viewport || !track) return;

    var frameCount = 4;
    var index = 0;
    var startX = 0;
    var dragX = 0;
    var pressing = false;

    function frameWidth() {
      return viewport.clientWidth / 3 || 1;
    }

    function paint(dx) {
      var w = frameWidth();
      var x = -(index * w) + dx;
      track.style.transform = 'translate3d(' + x + 'px,0,0)';
    }

    function snap() {
      track.classList.remove('is-dragging');
      paint(0);
    }

    function onDown(clientX) {
      pressing = true;
      startX = clientX;
      dragX = 0;
      track.classList.add('is-dragging');
    }

    function onMove(clientX) {
      if (!pressing) return;
      dragX = clientX - startX;
      paint(dragX);
    }

    function onUp() {
      if (!pressing) return;
      pressing = false;
      var threshold = frameWidth() * 0.22;
      if (dragX < -threshold && index < frameCount - 3) index += 1;
      else if (dragX > threshold && index > 0) index -= 1;
      snap();
    }

    viewport.addEventListener('touchstart', function (e) {
      if (e.touches.length === 1) onDown(e.touches[0].clientX);
    }, { passive: true });

    viewport.addEventListener('touchmove', function (e) {
      if (e.touches.length === 1) onMove(e.touches[0].clientX);
    }, { passive: true });

    viewport.addEventListener('touchend', onUp);
    viewport.addEventListener('touchcancel', onUp);

    viewport.addEventListener('mousedown', function (e) {
      onDown(e.clientX);
      e.preventDefault();
    });

    window.addEventListener('mousemove', function (e) {
      if (pressing) onMove(e.clientX);
    });

    window.addEventListener('mouseup', onUp);
  })();

  (function initDeskPager() {
    var viewport = document.getElementById('desk-viewport');
    var track = document.getElementById('desk-track');
    var pager = document.getElementById('desk-pager');
    if (!viewport || !track) return;

    var PAGE_COUNT = 4;
    var page = 0;
    var scrollRaf = 0;

    function pageWidth() {
      return track.clientWidth || 1;
    }

    function updateUI(n) {
      page = Math.max(0, Math.min(PAGE_COUNT - 1, n));
      viewport.setAttribute('data-desk-page', String(page));
      var dots = document.querySelectorAll('.desk-pager__dot');
      dots.forEach(function (dot, i) {
        var on = i === page;
        dot.classList.toggle('is-active', on);
        dot.setAttribute('aria-current', on ? 'page' : 'false');
      });
    }

    function setPage(n, behavior) {
      var target = Math.max(0, Math.min(PAGE_COUNT - 1, n));
      updateUI(target);
      if (behavior === 'auto') track.classList.add('is-programmatic');
      track.scrollTo({ left: target * pageWidth(), behavior: behavior || 'smooth' });
      if (behavior === 'auto') {
        requestAnimationFrame(function () {
          track.classList.remove('is-programmatic');
        });
      }
    }

    function onScroll() {
      if (scrollRaf) return;
      scrollRaf = requestAnimationFrame(function () {
        scrollRaf = 0;
        var i = Math.round(track.scrollLeft / pageWidth());
        if (i !== page) updateUI(i);
      });
    }

    if (!track._deskScrollBound) {
      track._deskScrollBound = true;
      track.addEventListener('scroll', onScroll, { passive: true });
    }

    if (pager && !pager._deskPagerBound) {
      pager._deskPagerBound = true;
      pager.addEventListener('click', function (e) {
        var dot = e.target.closest('[data-desk-page]');
        if (!dot) return;
        setPage(parseInt(dot.getAttribute('data-desk-page'), 10) || 0, 'smooth');
      });
    }

    window.addEventListener('resize', function () {
      track.scrollTo({ left: page * pageWidth(), behavior: 'auto' });
    });

    updateUI(0);
    track.scrollTo({ left: 0, behavior: 'auto' });
    if (window.miyaBindScrollBlur) {
      window.miyaBindScrollBlur(track, { idleMs: 120 });
    }
  })();

  var APP_HANDLERS = {
    set: function () {
      if (window.miyaSettingsApp && window.miyaSettingsApp.open) window.miyaSettingsApp.open();
    },
    beauty: function () {
      if (window.miyaBeautifyApp && window.miyaBeautifyApp.open) window.miyaBeautifyApp.open();
    },
    book: function () {
      if (window.miyaWorldbookApp && window.miyaWorldbookApp.open) window.miyaWorldbookApp.open();
    },
    chat: function () {
      if (window.miyaChatApp && window.miyaChatApp.open) window.miyaChatApp.open();
    },
    contacts: function () {
      if (window.miyaContactsApp && window.miyaContactsApp.open) window.miyaContactsApp.open();
    },
    memory: function () {
      if (window.miyaMemoryApp && window.miyaMemoryApp.open) window.miyaMemoryApp.open();
    },
    stpreset: function () {
      if (window.miyaStPromptPresetsApp && window.miyaStPromptPresetsApp.open) window.miyaStPromptPresetsApp.open();
    },
    store: function () {
      if (window.miyaOfflineApp && window.miyaOfflineApp.open) window.miyaOfflineApp.open();
    },
    pen: function () {
      if (window.miyaModeSwitch && window.miyaModeSwitch.setMode) {
        window.miyaModeSwitch.setMode('sim');
      }
    },
    itinerary: function () {
      if (window.miyaItineraryApp && window.miyaItineraryApp.open) window.miyaItineraryApp.open();
    },
    weather: function () {
      if (window.miyaWeatherApp && window.miyaWeatherApp.open) window.miyaWeatherApp.open();
    },
    couple: function () {
      if (window.miyaCoupleApp && window.miyaCoupleApp.open) window.miyaCoupleApp.open();
    },
    notes: function () {
      if (window.miyaDiaryApp && window.miyaDiaryApp.open) window.miyaDiaryApp.open();
    },
    fun: function () {
      if (window.miyaFunApp && window.miyaFunApp.open) window.miyaFunApp.open();
    },
    imagegen: function () {
      if (window.miyaSettingsApp && window.miyaSettingsApp.open) {
        /* fromDesk：从桌面图标直达，返回时应退出设置层回桌面 */
        window.miyaSettingsApp.open('miya-st-panel-imagegen', { fromDesk: true });
      }
    },
  };

  /* 安卓：打开全屏应用后，同一次触摸的 ghost click 会落到新页面按钮上（如设置→运转规则） */
  var OPEN_CLICK_GUARD_MS = 420;

  function armOpenClickGuard(root) {
    if (!root || !root.appendChild) return;
    var shield = null;
    var kids = root.children;
    for (var i = 0; i < kids.length; i++) {
      if (kids[i].classList && kids[i].classList.contains('miya-open-click-guard')) {
        shield = kids[i];
        break;
      }
    }
    if (!shield) {
      shield = document.createElement('div');
      shield.className = 'miya-open-click-guard';
      shield.setAttribute('aria-hidden', 'true');
      root.appendChild(shield);
    }
    shield.hidden = false;
    root.classList.add('is-open-guard');
    if (root._miyaOpenGuardTimer) clearTimeout(root._miyaOpenGuardTimer);
    root._miyaOpenGuardTimer = setTimeout(function () {
      shield.hidden = true;
      root.classList.remove('is-open-guard');
      root._miyaOpenGuardTimer = 0;
    }, OPEN_CLICK_GUARD_MS);
  }

  window.miyaArmOpenClickGuard = armOpenClickGuard;

  function launchApp(id) {
    if (!id) return false;
    if (APP_HANDLERS[id]) {
      var run = function () {
        APP_HANDLERS[id]();
      };
      if (window.miyaLazyEnsureApp) {
        window.miyaLazyEnsureApp(id).then(run).catch(run);
      } else {
        run();
      }
      return true;
    }
    if (id === 'pen' && window.miyaModeSwitch) {
      if (window.miyaLazyEnsureApp) {
        window.miyaLazyEnsureApp('pen').then(function () {
          window.miyaModeSwitch.setMode('sim');
        }).catch(function () {
          window.miyaModeSwitch.setMode('sim');
        });
      } else {
        window.miyaModeSwitch.setMode('sim');
      }
      return true;
    }
    var modal = document.getElementById('modal');
    if (!modal) return false;
    document.getElementById('modal-icon').innerHTML = SVG[id] || '';
    document.getElementById('modal-title').textContent = NAMES[id] || id;
    modal.hidden = false;
    return true;
  }

  window.miyaLaunchApp = launchApp;

  var phoneLayer = document.getElementById('miya-phone-layer');
  if (phoneLayer) {
    phoneLayer.addEventListener('click', function (e) {
    if (window.miyaCustomDragDidConsume && window.miyaCustomDragDidConsume()) return;
    if (window.miyaCustomEditModeActive && window.miyaCustomEditModeActive()) return;
    var btn = e.target.closest('[data-app]');
    if (!btn) return;
    launchApp(btn.getAttribute('data-app'));
  });
  }

  /* 开屏遮罩收尾：桌面层此时已完成渲染，撤掉遮罩并放出桌面。
     先让 body 退出 miya-booting（触发 .phone 的入场过渡），
     再给遮罩加 is-done 淡出，最后从 DOM 里摘掉，避免残留节点影响命中测试。
     淡出只留 200ms：遮罩本身只是为了盖住首帧，停留越短越不浪费用户时间。 */
  var bootCoverDone = false;
  function finishPhoneBoot() {
    if (bootCoverDone) return;
    bootCoverDone = true;
    clearTimeout(bootCoverFallback);
    document.body.classList.remove('miya-booting');
    phoneLayer.classList.add('is-active');
    var cover = document.getElementById('miya-bootcover');
    if (!cover) return;
    cover.classList.add('is-done');
    setTimeout(function () {
      if (cover.parentNode) cover.parentNode.removeChild(cover);
    }, 220);
  }

  /* 兜底保险：一切正常时下面会主动提前释放，走不到这里。
     仅在远程资源请求彻底挂起（无响应）时兜底，避免遮罩无限期盖住界面。 */
  var bootCoverFallback = setTimeout(finishPhoneBoot, 1800);

  /* 遮罩的真正目的是「别让用户看到半成品桌面」。
     桌面骨架只要 DOM 挂好就能看，没必要等壁纸 / 字体 / 小组件配图这些
     装饰性资源全部 settle。所以这里改用两段式：
       1) 桌面节点一挂载（或主题水合完成）→ 立刻放行遮罩
       2) 剩余装饰资源继续在后台补齐，用户已经在操作了 */
  function releaseCoverNow() {
    if (window.miyaLockscreen && window.miyaLockscreen.showIfNeeded) {
      window.miyaLockscreen.showIfNeeded();
    }
    if (window.miyaUpdateNotice && window.miyaUpdateNotice.onEntryStep) {
      window.miyaUpdateNotice.onEntryStep('splash');
    }
    finishPhoneBoot();
  }

  /* 等桌面骨架出现：轮询 desk-custom-track 是否已有子节点。
     这通常比 miyaHydrateTheme 的完整 resolve 早一大截（后者还在等壁纸加载）。 */
  function releaseWhenDeskMounted() {
    var deadline = Date.now() + 1500;
    (function poll() {
      if (bootCoverDone) return;
      var track = document.getElementById('desk-custom-track');
      if (track && track.children.length) {
        releaseCoverNow();
        return;
      }
      if (Date.now() > deadline) return; /* 交给兜底或水合回调 */
      requestAnimationFrame(poll);
    })();
  }

  function runPhoneBoot() {
    if (typeof window.miyaHydrateTheme === 'function') {
      /* 并行：一边等主题水合，一边盯着桌面骨架是否已经挂好 */
      releaseWhenDeskMounted();
      window.miyaHydrateTheme().then(function () {
        releaseCoverNow();
      }).catch(function () {
        if (typeof window.miyaInitHomeCopyEdit === 'function') window.miyaInitHomeCopyEdit();
        releaseCoverNow();
      });
    } else if (typeof window.miyaInitHomeCopyEdit === 'function') {
      window.miyaInitHomeCopyEdit();
      releaseCoverNow();
    } else {
      releaseCoverNow();
    }
  }

  if (window.miyaAuth && typeof window.miyaAuth.whenReady === 'function') {
    window.miyaAuth.whenReady().then(runPhoneBoot);
  } else {
    runPhoneBoot();
  }

  document.getElementById('modal-close').addEventListener('click', function () {
    document.getElementById('modal').hidden = true;
  });
  document.getElementById('modal').addEventListener('click', function (e) {
    if (e.target.id === 'modal') document.getElementById('modal').hidden = true;
  });

  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('./sw.js?v=70').then(function (reg) {
        try { reg.update(); } catch (e) {}
      }).catch(function () {});
    });
  }

  if (window.miyaModeSwitch && window.miyaModeSwitch.init) {
    window.miyaModeSwitch.init();
  }

  /* 程序坞 · 点击空白隐藏 / 点击底部显示 */
  (function initDockToggle() {
    var foot = document.querySelector('.foot');
    var dock = document.querySelector('.foot__dock');
    var dismiss = document.querySelector('.foot__dock-dismiss');
    var phone = document.getElementById('miya-phone-layer');
    if (!foot || !dock) return;

    var REVEAL_H = 120;

    function hideDock() {
      foot.classList.add('is-dock-hidden');
      if (phone) phone.classList.add('is-dock-hidden');
    }

    function showDock() {
      foot.classList.remove('is-dock-hidden');
      if (phone) phone.classList.remove('is-dock-hidden');
    }

    if (dismiss) {
      dismiss.addEventListener('click', function (e) {
        if (foot.classList.contains('is-dock-hidden')) return;
        e.preventDefault();
        e.stopPropagation();
        hideDock();
      });
    }


    foot.addEventListener('click', function () {
      if (foot.classList.contains('is-dock-hidden')) showDock();
    });

    if (phone) {
      phone.addEventListener('click', function (e) {
        if (!foot.classList.contains('is-dock-hidden')) return;
        var rect = phone.getBoundingClientRect();
        if (e.clientY >= rect.bottom - REVEAL_H) showDock();
      });
    }
  })();

  /* 桌面音乐播放器小组件 */
  (function initPlayer() {
    var player = document.getElementById('wg-player');
    var toggle = document.getElementById('player-toggle');
    var fill = document.getElementById('player-fill');
    var head = player && player.querySelector('.wg-player__bar-head');
    var cur = document.getElementById('player-cur');
    var lyric = document.getElementById('player-lyric');
    if (!player || !toggle) return;

    var LYRICS = [
      '把灯关小一点就好',
      '电梯里有人在哼歌',
      '路口红灯闪了三下',
      '回家路上买了橘子和牛奶'
    ];
    var total = 222;
    var pos = 84;
    var li = 0;
    var timer = null;

    function fmt(s) {
      var m = Math.floor(s / 60);
      var sec = s % 60;
      return pad(m) + ':' + pad(sec);
    }

    function syncBar() {
      var pct = Math.min(100, (pos / total) * 100);
      if (fill) fill.style.width = pct + '%';
      if (head) head.style.left = pct + '%';
      if (cur) cur.textContent = fmt(pos);
    }

    function cycleLyric() {
      if (!lyric) return;
      var custom = window.miyaGetTheme && window.miyaGetTheme().copy;
      if (custom && custom.playerLyric) return;
      lyric.classList.add('is-fade');
      setTimeout(function () {
        li = (li + 1) % LYRICS.length;
        lyric.textContent = LYRICS[li];
        lyric.classList.remove('is-fade');
      }, 500);
    }

    function tickPlayer() {
      if (!player.classList.contains('is-playing')) return;
      pos += 1;
      if (pos >= total) pos = 0;
      syncBar();
      if (pos % 18 === 0) cycleLyric();
    }

    function pauseDeskPlayerTimer() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    }

    function resumeDeskPlayerTimer() {
      if (!player.classList.contains('is-playing') || timer) return;
      if (document.hidden || document.body.classList.contains('miya-app-open')) return;
      timer = setInterval(tickPlayer, 1000);
    }

    function setPlaying(on) {
      player.classList.toggle('is-playing', on);
      toggle.setAttribute('aria-label', on ? '暂停' : '播放');
      if (on) resumeDeskPlayerTimer();
      else pauseDeskPlayerTimer();
    }

    document.addEventListener('visibilitychange', function () {
      if (document.hidden) pauseDeskPlayerTimer();
      else resumeDeskPlayerTimer();
    });

    if (typeof MutationObserver === 'function' && document.body) {
      new MutationObserver(function () {
        if (document.body.classList.contains('miya-app-open')) pauseDeskPlayerTimer();
        else resumeDeskPlayerTimer();
      }).observe(document.body, { attributes: true, attributeFilter: ['class'] });
    }

    toggle.addEventListener('click', function (e) {
      e.stopPropagation();
      setPlaying(!player.classList.contains('is-playing'));
    });

    player.addEventListener('click', function (e) {
      if (e.target.closest('.wg-player__btn')) return;
      if (e.target.closest('[data-miya-copy]')) return;
      setPlaying(!player.classList.contains('is-playing'));
    });

    syncBar();
  })();



  if (window.miyaBootstrapKvStoresIdle) {
    window.miyaBootstrapKvStoresIdle();
  } else if (window.miyaBootstrapKvStores) {
    window.miyaBootstrapKvStores().catch(function () {});
  }

  if (window.miyaRequestPersistentStorage) {
    window.miyaRequestPersistentStorage();
  }
})();
