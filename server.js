const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const cors = require('cors');
const crypto = require('crypto');

const app = express();
app.use('/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());
app.use(cors());

const FB_PIXEL_ID = '753350047833434';
const FB_ACCESS_TOKEN = process.env.FB_ACCESS_TOKEN;

function getShopifyToken() {
  return process.env.SHOPIFY_ADMIN_TOKEN;
}

async function sendTelegramAlert(message) {
  try {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (!token || !chatId) return;
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: message,
        parse_mode: 'HTML',
      }),
    });
  } catch (err) {
    console.error('❌ Erro ao enviar Telegram:', err.message);
  }
}

async function updateRailwayToken(newToken) {
  try {
    const mutation = `
      mutation {
        variableUpsert(input: {
          projectId: "${process.env.RAILWAY_PROJECT_ID}"
          serviceId: "${process.env.RAILWAY_SERVICE_ID}"
          environmentId: "${process.env.RAILWAY_ENVIRONMENT_ID}"
          name: "SHOPIFY_ADMIN_TOKEN"
          value: "${newToken}"
        })
      }
    `;
    await fetch("https://backboard.railway.app/graphql/v2", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.RAILWAY_API_TOKEN}`
      },
      body: JSON.stringify({ query: mutation })
    });
    console.log('✅ Token actualizado no Railway!');
  } catch (err) {
    console.error('❌ Erro ao actualizar Railway:', err.message);
  }
}

async function renewShopifyToken() {
  try {
    console.log('🔄 A renovar token Shopify...');
    const response = await fetch(
      `https://vu1ntd-yz.myshopify.com/admin/oauth/access_token`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: process.env.SHOPIFY_CLIENT_ID,
          client_secret: process.env.SHOPIFY_CLIENT_SECRET,
          grant_type: 'client_credentials',
        }),
      }
    );
    const data = await response.json();
    if (data.access_token) {
      process.env.SHOPIFY_ADMIN_TOKEN = data.access_token;
      await updateRailwayToken(data.access_token);
      console.log('✅ Token renovado com sucesso!');
      return true;
    } else {
      throw new Error(JSON.stringify(data));
    }
  } catch (err) {
    console.error('❌ Erro ao renovar token:', err.message);
    return false;
  }
}

async function ensureValidToken() {
  try {
    const response = await fetch(
      'https://vu1ntd-yz.myshopify.com/admin/api/2024-01/shop.json',
      { headers: { 'X-Shopify-Access-Token': getShopifyToken() } }
    );
    if (response.status === 401 || response.status === 403) {
      console.log('⚠️ Token inválido — a renovar antes do pedido...');
      const renewed = await renewShopifyToken();
      if (!renewed) throw new Error('Não foi possível renovar o token Shopify.');
    }
  } catch (err) {
    throw new Error(`Erro ao verificar token: ${err.message}`);
  }
}

setInterval(renewShopifyToken, 23 * 60 * 60 * 1000);

function hashData(value) {
  if (!value) return undefined;
  return crypto.createHash('sha256').update(value.trim().toLowerCase()).digest('hex');
}

async function sendFacebookPurchaseEvent({ email, amount, currency = 'eur', orderId, orderName }) {
  try {
    const eventData = {
      data: [{
        event_name: 'Purchase',
        event_time: Math.floor(Date.now() / 1000),
        action_source: 'website',
        event_source_url: 'https://www.anadalfama.pt',
        user_data: {
          em: [hashData(email)],
          country: [hashData('pt')],
        },
        custom_data: {
          currency: currency.toLowerCase(),
          value: amount,
          order_id: orderName || orderId,
        },
      }],
    };
    const response = await fetch(
      `https://graph.facebook.com/v19.0/${FB_PIXEL_ID}/events?access_token=${FB_ACCESS_TOKEN}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(eventData),
      }
    );
    const result = await response.json();
    if (result.error) {
      console.error('❌ Facebook CAPI erro:', result.error.message);
    } else {
      console.log(`✅ Facebook Purchase enviado — order ${orderName}, valor ${amount} ${currency}`);
    }
  } catch (err) {
    console.error('❌ Erro ao enviar evento Facebook:', err.message);
  }
}

app.post('/refresh-token', async (req, res) => {
  const { secret } = req.body;
  if (secret !== process.env.ADMIN_SECRET) {
    return res.status(401).json({ error: 'Não autorizado' });
  }
  await ensureValidToken();
  res.json({ success: true });
});

app.post('/update-token', (req, res) => {
  const { secret, token } = req.body;
  if (secret !== process.env.ADMIN_SECRET) {
    return res.status(401).json({ error: 'Não autorizado' });
  }
  process.env.SHOPIFY_ADMIN_TOKEN = token;
  console.log('✅ Token Shopify actualizado manualmente!');
  sendTelegramAlert('✅ <b>Token Shopify actualizado manualmente!</b>');
  res.json({ success: true });
});

app.post('/create-multibanco', async (req, res) => {
  try {
    const { amount, currency = 'eur', customer_email, customer_name, address, cart_items } = req.body;

    if (!amount || !customer_email) {
      return res.status(400).json({ error: 'Faltam campos obrigatórios' });
    }

    await ensureValidToken();

    const draftOrder = await createShopifyDraftOrder({ customer_email, customer_name, address, cart_items, amount });

    // ✅ Corrigido para Stripe v14 — criar PaymentMethod separadamente
    const paymentMethod = await stripe.paymentMethods.create({
      type: 'multibanco',
      billing_details: { email: customer_email },
    });

    const paymentIntent = await stripe.paymentIntents.create({
      amount: Math.round(amount * 100),
      currency,
      payment_method_types: ['multibanco'],
      payment_method: paymentMethod.id,
      confirm: true,
      metadata: {
        shopify_draft_order_id: draftOrder.id,
        shopify_draft_order_name: draftOrder.name,
        customer_email: customer_email,
        amount: amount,
        currency: currency,
        shop: 'anadalfama.pt',
      },
    });

    const mb = paymentIntent.next_action?.multibanco_display_details;
    if (!mb) throw new Error('Multibanco não ativado na Stripe.');

    await sendTelegramAlert(
      `🛍️ <b>Nova referência gerada!</b>\n\n` +
      `👤 Cliente: ${customer_name}\n` +
      `📧 Email: ${customer_email}\n` +
      `💶 Valor: ${amount}€\n` +
      `📦 Encomenda: ${draftOrder.name}`
    );

    res.json({
      payment_intent_id: paymentIntent.id,
      entity: mb.entity,
      reference: mb.reference,
      amount: amount,
      expires_at: mb.expires_at,
      order_name: draftOrder.name,
    });

  } catch (err) {
    console.error('Erro:', err.message);
    await sendTelegramAlert(
      `🚨 <b>Erro ao gerar referência!</b>\n\n` +
      `❌ Erro: ${err.message}\n\n` +
      `Um cliente tentou pagar mas não conseguiu.\n` +
      `Verifica o servidor no Railway!`
    );
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
      tags: 'multibanco,aguarda-pagamento',
      note: 'Pagamento por Multibanco — aguarda confirmação',
    }
  };

  const response = await fetch(
    'https://vu1ntd-yz.myshopify.com/admin/api/2024-01/draft_orders.json',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': getShopifyToken(),
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
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'payment_intent.succeeded') {
    const pi = event.data.object;
    const draftOrderId = pi.metadata?.shopify_draft_order_id;
    if (draftOrderId) {
      console.log(`✅ Pagamento confirmado — a completar encomenda #${draftOrderId}`);
      const order = await completeDraftOrder(draftOrderId, pi.id);
      if (order) {
        await sendTelegramAlert(
          `💰 <b>Pagamento confirmado!</b>\n\n` +
          `📦 Encomenda: ${order.name}\n` +
          `💶 Valor: ${pi.amount_received / 100}€\n` +
          `📧 Email: ${pi.metadata?.customer_email}`
        );
        await sendFacebookPurchaseEvent({
          email: pi.metadata?.customer_email,
          amount: parseFloat(pi.metadata?.amount) || (pi.amount_received / 100),
          currency: pi.metadata?.currency || pi.currency,
          orderId: draftOrderId,
          orderName: order.name,
        });
      }
    }
  }

  if (event.type === 'payment_intent.payment_failed') {
    const pi = event.data.object;
    console.log(`⏱ Expirou — draft order ${pi.metadata?.shopify_draft_order_id}`);
    await sendTelegramAlert(
      `⏱ <b>Referência expirou sem pagamento</b>\n\n` +
      `📦 Encomenda: ${pi.metadata?.shopify_draft_order_name || 'N/A'}\n` +
      `📧 Email: ${pi.metadata?.customer_email || 'N/A'}\n` +
      `💶 Valor: ${pi.metadata?.amount || 'N/A'}€`
    );
  }

  res.json({ received: true });
});

async function completeDraftOrder(draftOrderId, paymentIntentId) {
  try {
    const response = await fetch(
      `https://vu1ntd-yz.myshopify.com/admin/api/2024-01/draft_orders/${draftOrderId}/complete.json?payment_gateway=multibanco&payment_pending=false`,
      {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'X-Shopify-Access-Token': getShopifyToken(),
        },
      }
    );
    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Erro ao completar draft order: ${error}`);
    }
    const data = await response.json();
    console.log(`✅ Encomenda ${data.order?.name} criada!`);
    return data.order;
  } catch (err) {
    console.error('Erro ao completar encomenda:', err.message);
    return null;
  }
}

app.get('/', (req, res) => res.json({ status: 'ok', service: 'Ana Dalfama — Multibanco Server' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Porta ${PORT}`));
