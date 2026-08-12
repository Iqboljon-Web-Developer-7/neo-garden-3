(function () {
  var COUNTDOWN_SECONDS = 120;
  var left = COUNTDOWN_SECONDS;
  var mmEl = document.getElementById('ng-mm');
  var ssEl = document.getElementById('ng-ss');

  function pad(n) { return String(n).padStart(2, '0'); }

  function render() {
    mmEl.textContent = pad(Math.floor(left / 60));
    ssEl.textContent = pad(left % 60);
  }

  render();
  setInterval(function () {
    // loops back to the full duration at zero, matching the design canvas preview
    left = left > 0 ? left - 1 : COUNTDOWN_SECONDS;
    render();
  }, 1000);
})();
