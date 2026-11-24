/* RH—MUSIC: принудительный переход на HTTPS для http://-визитов.
   Основной барьер — Cloudflare HSTS, но для pages.dev он применим только
   после первого HTTPS-визита; этот скрипт закрывает первый заход. */
(function () {
  'use strict';
  var host = location.hostname;
  if (location.protocol !== 'http:') return;
  if (host === 'localhost' || host === '127.0.0.1' || host === '[::1]') return;
  location.replace('https://' + location.host + location.pathname + location.search + location.hash);
})();
