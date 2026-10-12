/**
 * Opens Razorpay Checkout for an order created by the API (PAYMENT_PROVIDER=razorpay).
 * The browser's success callback is NOT trusted: the booking only becomes PAID when the
 * signed webhook (or reconciliation) arrives, and the page polls for that.
 */
interface RazorpayInstance {
  open(): void;
}
type RazorpayConstructor = new (options: Record<string, unknown>) => RazorpayInstance;

declare global {
  interface Window {
    Razorpay?: RazorpayConstructor;
  }
}

const SCRIPT_URL = 'https://checkout.razorpay.com/v1/checkout.js';

function loadScript(): Promise<RazorpayConstructor> {
  if (window.Razorpay) return Promise.resolve(window.Razorpay);
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = SCRIPT_URL;
    script.onload = () => {
      if (window.Razorpay) resolve(window.Razorpay);
      else reject(new Error('Razorpay failed to load'));
    };
    script.onerror = () => {
      reject(new Error('Razorpay failed to load'));
    };
    document.head.appendChild(script);
  });
}

export async function openRazorpayCheckout(checkout: Record<string, unknown>, handlers: { onClose: () => void }): Promise<void> {
  const Razorpay = await loadScript();
  new Razorpay({
    key: checkout.keyId,
    order_id: checkout.orderId,
    amount: checkout.amountPaise,
    currency: checkout.currency ?? 'INR',
    name: 'TicketFlow',
    handler: handlers.onClose,
    modal: { ondismiss: handlers.onClose },
  }).open();
}
