const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const cors = require('cors');

const app = express();

app.use('/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());
app.use(cors());

// ─── ROTA TEMPORÁRIA PARA OBTER O shpat_ ───────────────────────────────────
const SHOPIFY_CLIENT_ID = process.env.SHOPIFY_CLIENT_ID;
const SHOPIFY_CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;
const SHOP = 'anadalfama.myshopify.com';
const SCOPES = 'read_customers,write_customers,write_draft_orders,read_draft_orders,read_orders,write_orders';

app.get('/auth', (req, res) => {
  const redirectUri = `https://${req.headers.host}/auth/callback`;
  const authUrl = `https://${SHOP}/admin/oauth/authorize?client_id=${SHOPIFY_CLIENT_ID}&scope=${SCOPES}&redirect_uri=${redirectUri}&state=secure123`;
  res.redirect(authUrl);
});

app.get('/auth/callback', async (req, res) => {
  const { code, state } = req.query;
  if (state !== 'secure123') return res.status(400).send('State inválido');

  try {
    const response = await fetch(`https://${SHOP}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: SHOPIFY_CLIENT_ID,
        client_secret: SHOPIFY_CLIENT_SECRET,
        code,
      }),
    });
    const data = await response.json();
    res.send(`<h1>✅ Token obtido!</h1><p>Copia este token para o Railway:</p><pre style="font-size:18px;background:#eee;padding:20px">${data.access_token}</pre><p>Depois remove a rota /auth do servidor.</p>`);
  } catch (err) {
    res.status(500).send(`Erro: ${err.message}`);
  }
});
// ───────────────────────────────────────────────────────────────────────────

app.post('/create-multibanco', async (req, res) => {
  try {
    const { amount, currency = 'eur', customer_email, customer_name, address, cart_items } = req.body;

    if (!amount || !customer_email) {
      return res.status(400).json({ error: 'Faltam campos obrigatórios' });
    }

    const draftOrder = await createShopifyDraftOrder({ customer_email, customer_name, address, cart_items, amount });

    const paymentIntent = await stripe.paymentIntents.create({
      amount: Math.round(amount * 100),
      currency,
      payment_method_types: ['multibanco'],
      payment_method_data: {
        type: 'multibanco',
        billing_details: { email: customer_email },
      },
      confirm: true,
      metadata: {
        shopify_draft_order_id: draftOrder.id,
        shopify_draft_order_name: draftOrder.name,
        shop: 'anadalfama.pt',
      },
    });

    const multibancoDetails = paymentIntent.next_action?.multibanco_display_details;

    if (!multibancoDetails) {
      throw new Error('A Stripe não devolveu dados Multibanco. Verifica se o método está aprovado na tua conta.');
    }

    res.json({
      payment_intent_id: paymentIntent.id,
      entity: multibancoDetails.entity,
      reference: multibancoDetails.reference,
      amount: amount,
      expires_at: multibancoDetails.expires_at,
      order_name: draftOrder.name,
    });

  } catch (err) {
    console.error('Erro ao criar Multibanco:', err.message);
    res.status(500).json({ error: err.message });
  }
});

async function createShopifyDraftOrder({ customer_email, customer_name, address, cart_items, amount }) {
  const nameParts = (customer_name || '').split(' ');
  const firstName = nameParts[0] || '';
  const lastName = nameParts.slice(1).join(' ') || '';

  const lineItems = cart_items?.map(item => ({
    variant_id: item.variant_id,
    quantity: item.quantity,
  })) || [];

  const body = {
    draft_order: {
      line_items: lineItems,
      customer: { email: customer_email },
      shipping_address: {
        first_name: firstName,
        last_name: lastName,
        address1: address?.address1 || '',
        city: address?.city || '',
        zip: address?.zip || '',
        country: address?.country || 'PT',
        phone: address?.phone || '',
      },
      billing_address: {
        first_name: firstName,
        last_name: lastName,
        address1: address?.address1 || '',
        city: address?.city || '',
        zip: address?.zip || '',
        country: address?.country || 'PT',
      },
      shipping_line: {
        title: 'Envio Standard',
        price: '0.00',
        code: 'envio-standard',
      },
      financial_status: 'pending',
      tags: 'multibanco,aguarda-pagamento',
      note: 'Pagamento por Multibanco — aguarda confirmação',
    }
  };

  const response = await fetch(
    'https://anadalfama.myshopify.com/admin/api/2024-01/draft_orders.json',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': process.env.SHOPIFY_ADMIN_TOKEN,
      },
      body: JSON.stringify(body),
    }
  );

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Shopify Draft Order erro: ${error}`);
  }

  const data = await response.json();
  return data.draft_order;
}

app.post('/webhook', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook inválido:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'payment_intent.succeeded') {
    const paymentIntent = event.data.object;
    const draftOrderId = paymentIntent.metadata?.shopify_draft_order_id;
    if (draftOrderId) {
      console.log(`✅ Pagamento confirmado — a completar encomenda #${draftOrderId}`);
      await completeDraftOrder(draftOrderId, paymentIntent.id);
    }
  }

  if (event.type === 'payment_intent.payment_failed') {
    const paymentIntent = event.data.object;
    console.log(`⏱ Referência expirou — draft order ${paymentIntent.metadata?.shopify_draft_order_id}`);
  }

  res.json({ received: true });
});

async function completeDraftOrder(draftOrderId, paymentIntentId) {
  try {
    const response = await fetch(
      `https://anadalfama.myshopify.com/admin/api/2024-01/draft_orders/${draftOrderId}/complete.json?payment_gateway=multibanco&payment_pending=false`,
      {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'X-Shopify-Access-Token': process.env.SHOPIFY_ADMIN_TOKEN,
        },
      }
    );

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Erro ao completar draft order: ${error}`);
    }

    const data = await response.json();
    console.log(`✅ Encomenda ${data.order?.name} criada com sucesso!`);
  } catch (err) {
    console.error('Erro ao completar encomenda:', err.message);
  }
}

app.get('/', (req, res) => res.json({ status: 'ok', service: 'Ana Dalfama — Multibanco Server' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Servidor Multibanco na porta ${PORT}`));
