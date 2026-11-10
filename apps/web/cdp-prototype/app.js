/* KICK'S Consumer Data Portfolio — mock prototype behavior.
   No external calls. No network requests. All data is hard-coded mock data
   from the founder's spec, rendered locally only. */

(function () {
  'use strict';

  /* ---------- Screen navigation ---------- */
  var nav = document.getElementById('screenNav');
  nav.addEventListener('click', function (event) {
    var button = event.target.closest('button[data-screen]');
    if (!button) return;
    var target = button.getAttribute('data-screen');
    var buttons = nav.querySelectorAll('button[data-screen]');
    buttons.forEach(function (b) { b.classList.toggle('active', b === button); });
    document.querySelectorAll('.screen').forEach(function (section) {
      section.classList.toggle('active', section.id === target);
    });
    window.scrollTo(0, 0);
  });

  /* ---------- Asset allocation donut ---------- */
  var allocation = [
    { label: 'Behavioral Data', pct: 42, color: '#2563EB' },
    { label: 'Health Data', pct: 19, color: '#16a34a' },
    { label: 'Location Data', pct: 14, color: '#f59e0b' },
    { label: 'Purchase Data', pct: 11, color: '#dc2626' },
    { label: 'Financial Data', pct: 8, color: '#7c3aed' },
    { label: 'Device Telemetry', pct: 6, color: '#64748b' }
  ];

  function polarToCartesian(cx, cy, r, angleDeg) {
    var angleRad = (angleDeg - 90) * Math.PI / 180;
    return { x: cx + r * Math.cos(angleRad), y: cy + r * Math.sin(angleRad) };
  }

  function donutSlicePath(cx, cy, rInner, rOuter, startAngle, endAngle) {
    var startOuter = polarToCartesian(cx, cy, rOuter, startAngle);
    var endOuter = polarToCartesian(cx, cy, rOuter, endAngle);
    var startInner = polarToCartesian(cx, cy, rInner, endAngle);
    var endInner = polarToCartesian(cx, cy, rInner, startAngle);
    var largeArc = (endAngle - startAngle) > 180 ? 1 : 0;
    return [
      'M', startOuter.x.toFixed(2), startOuter.y.toFixed(2),
      'A', rOuter, rOuter, 0, largeArc, 1, endOuter.x.toFixed(2), endOuter.y.toFixed(2),
      'L', startInner.x.toFixed(2), startInner.y.toFixed(2),
      'A', rInner, rInner, 0, largeArc, 0, endInner.x.toFixed(2), endInner.y.toFixed(2),
      'Z'
    ].join(' ');
  }

  function renderDonut() {
    var wrap = document.getElementById('donutWrap');
    var cx = 120, cy = 120, rOuter = 100, rInner = 58;
    var svg = '<svg viewBox="0 0 240 240" width="240" height="240" role="presentation">';
    var angle = 0;
    allocation.forEach(function (slice) {
      var sweep = slice.pct / 100 * 360;
      svg += '<path d="' + donutSlicePath(cx, cy, rInner, rOuter, angle, angle + sweep) +
        '" fill="' + slice.color + '"><title>' + slice.label + ' ' + slice.pct + '%</title></path>';
      angle += sweep;
    });
    svg += '<text x="120" y="115" text-anchor="middle" font-size="15" fill="#555">Data</text>' +
      '<text x="120" y="138" text-anchor="middle" font-size="15" fill="#555">Composition</text></svg>';
    wrap.innerHTML = svg;

    var legend = document.getElementById('allocationLegend');
    legend.innerHTML = allocation.map(function (slice) {
      return '<li><span><span class="legend-dot" style="background:' + slice.color +
        '"></span>' + slice.label + '</span><strong>' + slice.pct + '%</strong></li>';
    }).join('');
  }

  /* ---------- Performance line chart ---------- */
  var performance = [
    { month: '2026 Jan', value: 410 },
    { month: '2026 Apr', value: 620 },
    { month: '2026 Jul', value: 980 },
    { month: '2026 Oct', value: 1480 }
  ];

  function renderLineChart() {
    var wrap = document.getElementById('lineWrap');
    var w = 640, h = 260, padL = 60, padR = 20, padT = 30, padB = 40;
    var max = 1600;
    function x(i) { return padL + i * (w - padL - padR) / (performance.length - 1); }
    function y(v) { return padT + (1 - v / max) * (h - padT - padB); }
    var points = performance.map(function (p, i) { return x(i) + ',' + y(p.value); }).join(' ');
    var svg = '<svg viewBox="0 0 ' + w + ' ' + h + '" role="presentation">';
    [0, 400, 800, 1200, 1600].forEach(function (v) {
      svg += '<line x1="' + padL + '" y1="' + y(v) + '" x2="' + (w - padR) + '" y2="' + y(v) +
        '" stroke="#e5e7eb" stroke-width="1"></line>' +
        '<text x="' + (padL - 8) + '" y="' + (y(v) + 4) + '" text-anchor="end" font-size="12" fill="#555">$' +
        v.toLocaleString('en-US') + '</text>';
    });
    svg += '<polyline points="' + points + '" fill="none" stroke="#2563EB" stroke-width="3"></polyline>';
    performance.forEach(function (p, i) {
      svg += '<circle cx="' + x(i) + '" cy="' + y(p.value) + '" r="5" fill="#2563EB"></circle>' +
        '<text x="' + x(i) + '" y="' + (y(p.value) - 12) + '" text-anchor="middle" font-size="13" font-weight="700" fill="#111">$' +
        p.value.toLocaleString('en-US') + '</text>' +
        '<text x="' + x(i) + '" y="' + (h - 12) + '" text-anchor="middle" font-size="12" fill="#555">' +
        p.month + '</text>';
    });
    svg += '</svg>';
    wrap.innerHTML = svg;
  }

  /* ---------- License revoke (mock) ---------- */
  var activeCount = 14;
  var revokeNote = document.getElementById('revokeNote');

  function updateLicenseCounts() {
    document.querySelectorAll('.license-count').forEach(function (el) {
      el.textContent = String(activeCount);
    });
  }

  document.getElementById('licenseList').addEventListener('click', function (event) {
    var button = event.target.closest('.revoke-btn');
    if (!button || button.disabled) return;
    var name = button.getAttribute('data-license');
    var row = button.closest('li');
    activeCount = Math.max(0, activeCount - 1);
    updateLicenseCounts();
    row.classList.add('revoked');
    button.disabled = true;
    button.textContent = 'Revoked';
    var tag = document.createElement('span');
    tag.className = 'revoked-tag';
    tag.textContent = 'Revoked';
    button.replaceWith(tag);
    revokeNote.hidden = false;
    revokeNote.textContent = 'Mock action: "' + name + '" revoked. It no longer counts toward your portfolio. ' +
      'Active licenses: ' + activeCount + '.';
  });

  renderDonut();
  renderLineChart();
})();
