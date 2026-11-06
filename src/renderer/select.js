// Seletor próprio, conforme o protótipo. Com o <select> nativo, o Chromium não avisa
// quando a lista abre ou fecha, e o overlay não saberia se pode sumir.
const CHEVRON = { up: 'M6 15l6-6 6 6', down: 'M6 9l6 6 6-6' };
const CHECK = '<svg class="cm-i" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12l5 5 9-10"></path></svg>';

let openInstance = null;

export const isMenuOpen = () => openInstance !== null;

document.addEventListener('click', ({ target }) => {
  if (openInstance && !openInstance.root.contains(target)) openInstance.close();
});

export function closeOpenMenu() {
  if (!openInstance) return false;
  openInstance.close({ refocus: true });
  return true;
}

// root já existe no HTML. icon é o SVG opcional mostrado antes do nome.
export function createSelect(root, { label, direction, icon = '', onChange }) {
  root.classList.add('cm-select');
  root.innerHTML = `
    <button type="button" class="cm-select-btn" aria-haspopup="listbox" aria-expanded="false">
      ${icon}
      <span class="cm-select-name"></span>
      <svg class="cm-i" viewBox="0 0 24 24" aria-hidden="true"><path d="${CHEVRON[direction]}"></path></svg>
    </button>
    <div class="cm-menu ${direction}" role="listbox" hidden></div>`;
  const button = root.querySelector('button');
  const name = root.querySelector('.cm-select-name');
  const menu = root.querySelector('.cm-menu');
  button.setAttribute('aria-label', label);
  menu.setAttribute('aria-label', label);

  let value = '';
  let signature = null;

  const optionButtons = () => [...menu.querySelectorAll('button')];

  const instance = {
    root,
    close({ refocus = false } = {}) {
      if (openInstance !== instance) return;
      openInstance = null;
      menu.hidden = true;
      button.setAttribute('aria-expanded', 'false');
      if (refocus) button.focus();
      else if (root.contains(document.activeElement)) document.activeElement.blur();
      root.dispatchEvent(new Event('menuclose', { bubbles: true }));
    },
    get value() {
      return value;
    },
    // fallbackLabel aparece quando o valor atual não está entre as opções.
    setOptions(options, newValue, fallbackLabel = '') {
      value = newValue;
      const selected = options.find((option) => option.value === value);
      name.textContent = selected?.label ?? fallbackLabel;
      button.title = name.textContent;
      button.disabled = options.length === 0;
      if (button.disabled) instance.close();

      const newSignature = JSON.stringify([options, value]);
      if (newSignature === signature) return;
      signature = newSignature;
      menu.replaceChildren(
        ...options.map((option) => {
          const item = document.createElement('button');
          item.type = 'button';
          item.className = 'cm-option';
          item.role = 'option';
          item.title = option.label;
          item.setAttribute('aria-selected', String(option.value === value));
          item.innerHTML = `<span class="cm-option-check">${option.value === value ? CHECK : ''}</span><span class="cm-select-name"></span>`;
          // Nomes de dispositivo vêm de fora do app: sempre como texto, nunca como HTML.
          item.querySelector('.cm-select-name').textContent = option.label;
          item.addEventListener('click', (event) => {
            instance.close({ refocus: event.detail === 0 });
            if (option.value !== value) {
              value = option.value;
              onChange(value);
            }
          });
          return item;
        }),
      );
    },
  };

  button.addEventListener('click', (event) => {
    if (openInstance === instance) {
      instance.close({ refocus: event.detail === 0 });
      return;
    }
    openInstance?.close();
    openInstance = instance;
    menu.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    (menu.querySelector('[aria-selected="true"]') ?? menu.querySelector('button'))?.focus();
  });

  menu.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const items = optionButtons();
    const step = event.key === 'ArrowDown' ? 1 : -1;
    const next = (items.indexOf(document.activeElement) + step + items.length) % items.length;
    items[next].focus();
  });

  return instance;
}
