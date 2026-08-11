(function () {
  var COUNTDOWN_MINUTES = 19;
  var left = COUNTDOWN_MINUTES * 60;
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
    left = left > 0 ? left - 1 : COUNTDOWN_MINUTES * 60;
    render();
  }, 1000);
})();
