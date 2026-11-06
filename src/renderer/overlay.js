import { isMenuOpen } from './select.js';

const HIDE_DELAY_MS = 2000;

// Overlay e cursor aparecem com o mouse e somem juntos quando ele para.
export function createOverlay(overlay) {
  let enabled = false;
  let timer = null;
  let lastX = null;
  let lastY = null;

  function hide() {
    // Com uma lista aberta, o overlay espera: fechá-la chama show() de novo.
    if (isMenuOpen()) return;
    if (overlay.contains(document.activeElement)) document.activeElement.blur();
    overlay.classList.remove('on');
    overlay.inert = true;
    document.body.classList.toggle('idle', enabled);
  }

  function show() {
    document.body.classList.remove('idle');
    if (!enabled) return;
    overlay.classList.add('on');
    overlay.inert = false;
    clearTimeout(timer);
    timer = setTimeout(hide, HIDE_DELAY_MS);
  }

  document.addEventListener('mousemove', ({ screenX, screenY }) => {
    // O Windows às vezes dispara mousemove sem o mouse ter saído do lugar.
    if (screenX === lastX && screenY === lastY) return;
    lastX = screenX;
    lastY = screenY;
    show();
  });

  overlay.addEventListener('menuclose', show);

  // Depois de usar um controle com o mouse, o foco volta para a página, e o
  // overlay pode sumir no tempo normal. Pelo teclado, o foco fica onde está.
  overlay.addEventListener('click', ({ target, detail }) => {
    if (detail) target.closest('.cm-mute, .cm-chip')?.blur();
  });
  overlay.addEventListener('pointerup', ({ target }) => {
    if (target.matches('input')) target.blur();
  });

  return {
    show,
    setEnabled(value) {
      if (enabled === value) return;
      enabled = value;
      clearTimeout(timer);
      if (enabled) show();
      else hide();
    },
  };
}

// Usa getSettings() para a resolução e requestVideoFrameCallback para o FPS real.
// Só mede enquanto o painel está aberto, para não custar nada no resto do tempo.
export function createInfoPanel(panel, video) {
  const resolution = panel.querySelector('#info-resolution');
  const fps = panel.querySelector('#info-fps');
  let interval = null;
  let frameRequest = null;
  let frames = 0;
  let windowStart = 0;
  let open = false;

  const countFrame = () => {
    frames += 1;
    frameRequest = video.requestVideoFrameCallback(countFrame);
  };

  const update = () => {
    const now = performance.now();
    const track = video.srcObject?.getVideoTracks()[0];
    const settings = track?.getSettings();
    resolution.textContent = settings ? `${settings.width} x ${settings.height}` : '—';
    const rate = frames / ((now - windowStart) / 1000);
    fps.textContent = track ? `${rate.toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} FPS` : '—';
    frames = 0;
    windowStart = now;
  };

  return {
    toggle() {
      open = !open;
      panel.classList.toggle('on', open);
      panel.setAttribute('aria-hidden', String(!open));
      if (!open) {
        clearInterval(interval);
        video.cancelVideoFrameCallback(frameRequest);
        return;
      }
      frames = 0;
      windowStart = performance.now();
      resolution.textContent = '—';
      fps.textContent = '—';
      frameRequest = video.requestVideoFrameCallback(countFrame);
      interval = setInterval(update, 1000);
    },
  };
}
