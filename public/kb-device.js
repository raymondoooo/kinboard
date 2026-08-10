// A stable per-browser device id, shared by the calendar and settings pages.
//
// Kinboard has no individual logins — everyone shares one household password —
// so "who is this?" for notification purposes is really "which device is this?".
// This id is what lets the server skip notifying the device that just created an
// event, and it survives the push subscription itself being reissued (browsers
// rotate endpoints, so the endpoint alone isn't a stable identity).
//
// Lives in its own file rather than being copy-pasted into both pages: the two
// copies drifting on the storage key would silently break self-notification
// suppression, which is exactly the kind of bug nobody reports.
(function () {
  var KEY = 'kb_device_id';

  window.kbDeviceId = function () {
    try {
      var id = localStorage.getItem(KEY);
      if (!id) {
        id = (crypto.randomUUID && crypto.randomUUID()) ||
             String(Date.now()) + Math.random().toString(36).slice(2);
        localStorage.setItem(KEY, id);
      }
      return id;
    } catch (_) {
      return null; // private mode / storage blocked — self-suppression just won't apply
    }
  };

  // Web Push needs a secure context (HTTPS, or localhost) AND service-worker +
  // PushManager support. The server can't detect any of this, so the UI asks here
  // and hides the notification controls when the answer is no.
  window.kbPushSupported = function () {
    return !!(window.isSecureContext && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window);
  };

  // Register the service worker from EVERY page that loads this file, not just
  // the calendar. Push subscription happens on the settings page, and
  // navigator.serviceWorker.ready never resolves when nothing is registered for
  // the scope — so a settings page that assumed some other page had already
  // registered would hang forever with no error, and the "enable notifications"
  // button would silently do nothing.
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(function () { /* non-fatal */ });
  }

  // Await an ACTIVE service worker, registering first so `.ready` is guaranteed
  // to have something to resolve to. Bounded, because a hung promise here is
  // indistinguishable from a broken button.
  window.kbServiceWorker = function () {
    if (!('serviceWorker' in navigator)) return Promise.reject(new Error('Service workers are not supported in this browser'));
    return navigator.serviceWorker.register('/sw.js').then(function () {
      return Promise.race([
        navigator.serviceWorker.ready,
        new Promise(function (_, reject) {
          setTimeout(function () { reject(new Error('Service worker did not start in time — try reloading the page')); }, 10000);
        }),
      ]);
    });
  };
})();
