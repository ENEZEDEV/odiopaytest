import { MercadoPagoTestReader } from '../src/mercadopago.js';
import { AppError, requireThat } from '../src/errors.js';

try {
  requireThat(process.env.MP_ENABLE_TEST_READ === 'yes', 500, 'mp_test_read_opt_in_required');
  requireThat(/^\d+$/.test(process.env.MP_EXPECTED_AMOUNT_CENTS ?? ''), 500, 'mp_expected_amount_required');
  const client = new MercadoPagoTestReader({ accessToken: process.env.MP_TEST_ACCESS_TOKEN });
  const result = await client.getPayment(process.env.MP_TEST_PAYMENT_ID, {
    collectorId: process.env.MP_EXPECTED_COLLECTOR_ID,
    externalReference: process.env.MP_EXPECTED_REFERENCE,
    amountCents: Number(process.env.MP_EXPECTED_AMOUNT_CENTS),
    method: process.env.MP_EXPECTED_METHOD
  });
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(error instanceof AppError ? error.code : 'mp_verification_failed');
  process.exitCode = 1;
}
