const ROUTE = 'support';
const DEFAULT_AMOUNTS = Object.freeze(['50', '100', '250']);
const DEFAULT_PAYMENT = Object.freeze({
  address: 'dharshandcu@nyes',
  recipient: 'Dharshan S',
  currency: 'INR'
});

const byId = (root, id) => root.getElementById ? root.getElementById(id) : root.querySelector(`#${id}`);

export class SupportController {
  constructor(ui, {
    root = ui?.root || document,
    payment = DEFAULT_PAYMENT,
    amounts = DEFAULT_AMOUNTS
  } = {}) {
    this.ui = ui;
    this.root = root;
    this.payment = payment;
    this.amounts = new Set(amounts.map(String));
    this.listeners = [];
    this.mounted = false;
  }

  mount() {
    if (this.mounted || !this.ui?.registerRoute(ROUTE)) return this;
    this.mounted = true;
    this.root.querySelectorAll('[data-support-entry]').forEach(element => { element.hidden = false; });
    const screen = byId(this.root, 'support-screen');
    if (screen) this._listen(screen, 'click', event => this._handleClick(event));
    this.updatePayment();
    return this;
  }

  destroy() {
    this.listeners.splice(0).forEach(({ target, type, listener, options }) => {
      target.removeEventListener(type, listener, options);
    });
    this.root.querySelectorAll('[data-support-entry]').forEach(element => { element.hidden = true; });
    this.ui?.unregisterRoute(ROUTE);
    this.mounted = false;
  }

  async _handleClick(event) {
    const amount = event.target.closest('[data-donation-amount]');
    if (amount) {
      this.root.querySelectorAll('[data-donation-amount]').forEach(item => {
        item.setAttribute('aria-pressed', String(item === amount));
      });
      this.updatePayment(amount.dataset.donationAmount);
      return;
    }

    if (!event.target.closest('#support-copy')) return;
    const value = byId(this.root, 'support-upi-id')?.textContent.trim() || this.payment.address;
    try {
      await navigator.clipboard.writeText(value);
      this.ui.notify('UPI ID copied');
    } catch {
      this.ui.notify('Could not copy the UPI ID', true);
    }
  }

  updatePayment(amount = '') {
    if (!this.mounted) return;
    const params = new URLSearchParams({
      pa: this.payment.address,
      pn: this.payment.recipient,
      cu: this.payment.currency
    });
    if (this.amounts.has(String(amount))) params.set('am', String(amount));
    const intent = `upi://pay?${params.toString().replace(/\+/g, '%20')}`;
    byId(this.root, 'upi-handoff')?.setAttribute('href', intent);
    this.ui.renderQR('support-qr', intent);
  }

  _listen(target, type, listener, options) {
    if (!target) return;
    target.addEventListener(type, listener, options);
    this.listeners.push({ target, type, listener, options });
  }
}

export function mountSupport(ui, options) {
  return new SupportController(ui, options).mount();
}
