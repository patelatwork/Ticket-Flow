import { env } from '../../../config/env.js';
import { MockProvider, type MockConfig, type MockOrderStore } from './mock.js';
import { RazorpayProvider } from './razorpay.js';
import { PROVIDER_NAMES, type PaymentProvider, type ProviderName } from './types.js';

const providers = new Map<ProviderName, PaymentProvider>();

export function mockConfigFromEnv(): MockConfig {
  return {
    secret: env.MOCK_WEBHOOK_SECRET,
    delayMs: env.MOCK_PAYMENT_WEBHOOK_DELAY_MS,
    outcome: env.MOCK_PAYMENT_OUTCOME,
    duplicates: env.MOCK_PAYMENT_DUPLICATES,
    outOfOrder: env.MOCK_PAYMENT_OUT_OF_ORDER,
    dropWebhooks: env.MOCK_PAYMENT_DROP_WEBHOOKS,
  };
}

/**
 * Wires the providers at process start. The mock needs a shared order store and a way to
 * schedule webhook delivery, which differ between production (Redis + BullMQ) and tests.
 */
export function configurePaymentProviders(deps: {
  mockStore: MockOrderStore;
  scheduleMockDelivery: (orderId: string, delayMs: number) => Promise<void>;
  mockConfig?: MockConfig;
}): void {
  providers.set('mock', new MockProvider(deps.mockStore, deps.scheduleMockDelivery, deps.mockConfig ?? mockConfigFromEnv()));
  const { RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET, RAZORPAY_WEBHOOK_SECRET } = env;
  if (RAZORPAY_KEY_ID && RAZORPAY_KEY_SECRET && RAZORPAY_WEBHOOK_SECRET) {
    providers.set(
      'razorpay',
      new RazorpayProvider({ keyId: RAZORPAY_KEY_ID, keySecret: RAZORPAY_KEY_SECRET, webhookSecret: RAZORPAY_WEBHOOK_SECRET }),
    );
  }
}

/** Test hook: install a specific provider instance. */
export function setPaymentProvider(provider: PaymentProvider): void {
  providers.set(provider.name, provider);
}

export function isProviderName(name: string): name is ProviderName {
  return (PROVIDER_NAMES as readonly string[]).includes(name);
}

export function getPaymentProvider(name: ProviderName): PaymentProvider {
  const provider = providers.get(name);
  if (!provider) throw new Error(`payment provider "${name}" is not configured`);
  return provider;
}

/** The provider new orders are created with. */
export function activePaymentProvider(): PaymentProvider {
  return getPaymentProvider(env.PAYMENT_PROVIDER);
}
