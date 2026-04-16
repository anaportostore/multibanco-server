const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const cors = require('cors');

const app = express();

// Webhook precisa do body raw, por isso vem antes do express.json()
app.use('/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());
app.use(cors({ origin: 'https://www.anadalfama.pt' }));

// ─── 1. CRIAR REFERÊNCIA MULTIBANCO ────────────────────────────────────────
// O Shopify chama este endpoint quando o cliente escolhe Multibanco
app.post('/create-multibanco', async (req, res) => {
  try {
    const { amount, currency = 'eur', customer_email, order_id } = req.body;

    if (!amount || !customer_email || !order_id) {
      return res.status(400).json({ error: 'Faltam campos obrigatórios: amount, customer_email, order_id' });
    }

    // Cria o PaymentIntent com Multibanco
    const paymentIntent = await stripe.paymentIntents.create({
      amount: Math.round(amount * 100), // Stripe usa cêntimos: 47.90 → 4790
      currency,
      payment_method_types: ['multibanco'],
      payment_method_data: {
        type: 'multibanco',
        billing_details: { email: customer_email },
      },
      confirm: true,
      metadata: {
        shopify_order_id: order_id,
        shop: 'anadalfama.pt',
      },
    });

    // Extrai os dados Multibanco gerados pela Stripe
    const multibancoDetails = paymentIntent.next_action?.multibanco_display_details;

    if (!multibancoDetails) {
      throw new Error('A Stripe não devolveu dados Multibanco. Verifica se o método está aprovado na tua conta.');
    }

    res.json({
      payment_intent_id: paymentIntent.id,
      entity: multibancoDetails.entity,
      reference: multibancoDetails.reference,
      amount: amount,
      expires_at: multibancoDetails.expires_at, // timestamp Unix
    });

  } catch (err) {
    console.error('Erro ao criar Multibanco:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── 2. WEBHOOK — CONFIRMAR PAGAMENTO ──────────────────────────────────────
// A Stripe chama este endpoint quando o cliente paga no ATM/homebanking
app.post('/webhook', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('Webhook inválido:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Pagamento Multibanco confirmado ✅
  if (event.type === 'payment_intent.succeeded') {
    const paymentIntent = event.data.object;
    const shopifyOrderId = paymentIntent.metadata?.shopify_order_id;

    if (shopifyOrderId) {
      console.log(`✅ Pagamento confirmado para encomenda Shopify #${shopifyOrderId}`);

      // Marcar encomenda como paga no Shopify
      await confirmShopifyOrder(shopifyOrderId, paymentIntent.id);
    }
  }

  // Referência expirou sem pagamento ⏱
  if (event.type === 'payment_intent.payment_failed') {
    const paymentIntent = event.data.object;
    const shopifyOrderId = paymentIntent.metadata?.shopify_order_id;
    console.log(`⏱ Referência expirou para encomenda #${shopifyOrderId}`);
    // Podes aqui cancelar a encomenda no Shopify se quiseres
  }

  res.json({ received: true });
});

// ─── 3. CONFIRMAR ENCOMENDA NO SHOPIFY ─────────────────────────────────────
async function confirmShopifyOrder(orderId, paymentIntentId) {
  try {
    const response = await fetch(
      `https://anadalfama.myshopify.com/admin/api/2024-01/orders/${orderId}/transactions.json`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Shopify-Access-Token': process.env.SHOPIFY_ADMIN_TOKEN,
        },
        body: JSON.stringify({
          transaction: {
            kind: 'capture',
            status: 'success',
            gateway: 'stripe_multibanco',
            authorization: paymentIntentId,
          },
        }),
      }
    );

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Shopify API erro: ${error}`);
    }

    console.log(`✅ Encomenda #${orderId} marcada como paga no Shopify`);
  } catch (err) {
    console.error('Erro ao confirmar no Shopify:', err.message);
  }
}

// ─── HEALTH CHECK ───────────────────────────────────────────────────────────
app.get('/', (req, res) => res.json({ status: 'ok', service: 'Ana Dalfama — Multibanco Server' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Servidor Multibanco a correr na porta ${PORT}`));
