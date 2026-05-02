const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY, {
  apiVersion: '2024-06-20',
});
const cors = require('cors');
const crypto = require('crypto');

const app = express();
app.use('/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());
app.use(cors());

const FB_PIXEL_ID = '753350047833434';
const FB_ACCESS_TOKEN = process.env.FB_ACCESS_TOKEN;

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const ZAPI_INSTANCE_ID = process.env.ZAPI_INSTANCE_ID;
const ZAPI_TOKEN = process.env.ZAPI_TOKEN;

async function sendTelegramMessage(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  const chatIds = TELEGRAM_CHAT_ID.split(',').map(id => id.trim());
  for (const chatId of chatIds) {
    try {
      await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: text, parse_mode: 'HTML' }),
      });
    } catch (err) {
      console.error(`❌ Erro Telegram para ${chatId}:`, err.message);
    }
  }
}

async function sendWhatsAppMessage(phone, message) {
  if (!ZAPI_INSTANCE_ID || !ZAPI_TOKEN) {
    console.log('⚠️ Z-API não configurado');
    return;
  }
  if (!phone) return;

  let number = phone.replace(/[\s\+\-]/g, '');
  if (number.startsWith('00')) number = number.slice(2);
  if (number.startsWith('9') || number.startsWith('2')) number = '351' + number;

  try {
    const response = await fetch(
      `https://api.z-api.io/instances/${ZAPI_INSTANCE_ID}/token/${ZAPI_TOKEN}/send-text`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: number, message: message }),
      }
    );
    const result = await response.json();
    if (!response.ok) {
      console.error('❌ Z-API erro:', JSON.stringify(result));
    } else {
      console.log(`✅ WhatsApp enviado para ${number}`);
    }
  } catch (err) {
    console.error('❌ Erro WhatsApp:', err.message);
  }
}

function formatEUR(amount) {
  return `${parseFloat(amount).toFixed(2)} €`;
}

const SHOPIFY_SHOP = process.env.SHOPIFY_SHOP_DOMAIN || 'vu1ntd-yz.myshopify.com';
const SHOPIFY_CLIENT_ID = process.env.SHOPIFY_CLIENT_ID;
const SHOPIFY_CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;

let shopifyTokenCache = { token: null, expires_at: 0 };
let refreshPromise = null;

async function fetchNewShopifyToken() {
  console.log('🔄 A obter novo token Shopify...');
  const response = await fetch(
    `https://${SHOPIFY_SHOP}/admin/oauth/access_token`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'client_credentials',
        client_id: SHOPIFY_CLIENT_ID,
        client_secret: SHOPIFY_CLIENT_SECRET,
      }),
    }
  );
  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Falha ao obter token Shopify: ${error}`);
  }
  const data = await response.json();
  shopifyTokenCache = {
    token: data.access_token,
    expires_at: Date.now() + (data.expires_in * 1000),
  };
  console.log(`✅ Novo token Shopify obtido — expira em ${Math.round(data.expires_in / 3600)}h`);
  return shopifyTokenCache.token;
}

async function getShopifyToken() {
  const SAFETY_MARGIN = 5 * 60 * 1000;
  if (shopifyTokenCache.token && shopifyTokenCache.expires_at - Date.now() > SAFETY_MARGIN) {
    return shopifyTokenCache.token;
  }
  if (refreshPromise) return refreshPromise;
  refreshPromise = fetchNewShopifyToken().finally(() => { refreshPromise = null; });
  return refreshPromise;
}

async function shopifyFetch(path, options = {}) {
  let token = await getShopifyToken();
  let response = await fetch(`https://${SHOPIFY_SHOP}${path}`, {
    ...options,
    headers: {
      ...options.headers,
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': token,
    },
  });
  if (response.status === 401) {
    console.log('⚠️ Token Shopify rejeitado — a renovar...');
    shopifyTokenCache.expires_at = 0;
    token = await getShopifyToken();
    response = await fetch(`https://${SHOPIFY_SHOP}${path}`, {
      ...options,
      headers: {
        ...options.headers,
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': token,
      },
    });
  }
  return response;
}

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

app.post('/create-multibanco', async (req, res) => {
  try {
    const { amount, currency = 'eur', customer_email, customer_name, address, cart_items, product_url } = req.body;

    if (!amount || !customer_email) {
      return res.status(400).json({ error: 'Faltam campos obrigatórios' });
    }

    const draftOrder = await createShopifyDraftOrder({ customer_email, customer_name, address, cart_items, amount });

    const paymentMethod = await stripe.paymentMethods.create({
      type: 'multibanco',
      billing_details: { email: customer_email },
    });

    const paymentIntent = await stripe.paymentIntents.create({
      amount: Math.round(parseFloat(amount) * 100),
      currency,
      automatic_payment_methods: { enabled: true, allow_redirects: 'never' },
      payment_method: paymentMethod.id,
      confirm: true,
      return_url: 'https://www.anadalfama.pt',
      metadata: {
        shopify_draft_order_id: draftOrder.id,
        shopify_draft_order_name: draftOrder.name,
        customer_email: customer_email,
        customer_name: customer_name || '',
        customer_phone: address?.phone || '',
        product_url: product_url || 'https://www.anadalfama.pt',
        amount: amount,
        currency: currency,
        shop: 'anadalfama.pt',
      },
    });

    const mb = paymentIntent.next_action?.multibanco_display_details;
    if (!mb) throw new Error('Multibanco não ativado na Stripe.');

    // 📱 WhatsApp → Cliente (referência gerada)
    if (address?.phone) {
      const morada = [
        address?.address1,
        address?.city,
        address?.zip,
      ].filter(Boolean).join(', ');

      await sendWhatsAppMessage(address.phone,
        `Olá ${customer_name}! 👋\n\n` +
        `Obrigada pela sua encomenda na *Ana D'Alfama*! 🛍️\n\n` +
        `Para finalizar o seu pagamento use os seguintes dados:\n\n` +
        `・ Entidade: ${mb.entity}\n` +
        `・ Referência: ${mb.reference}\n` +
        `・ Valor: ${formatEUR(amount)}\n` +
        `・ Morada: ${morada || '—'}\n\n` +
        `Veja aqui o seu produto:\n${product_url || 'https://www.anadalfama.pt'}\n\n` +
        `Qualquer dúvida estamos aqui! ❤️`
      );
    }

    // 📱 Telegram → Tu e amigo
    await sendTelegramMessage(
      `🆕 <b>Nova referência Multibanco gerada</b>\n\n` +
      `📦 Encomenda: <b>${draftOrder.name}</b>\n` +
      `👤 Cliente: ${customer_name || '—'}\n` +
      `📧 Email: ${customer_email}\n` +
      `📱 Telefone: ${address?.phone || '—'}\n` +
      `💰 Valor: <b>${formatEUR(amount)}</b>\n\n` +
      `🏦 Entidade: <code>${mb.entity}</code>\n` +
      `🔢 Referência: <code>${mb.reference}</code>\n\n` +
      `⏳ <i>A aguardar pagamento...</i>`
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
    await sendTelegramMessage(
      `❌ <b>Erro ao gerar referência Multibanco</b>\n\n` +
      `📧 Email: ${req.body?.customer_email || '—'}\n` +
      `💰 Valor: ${req.body?.amount ? formatEUR(req.body.amount) : '—'}\n\n` +
      `⚠️ Erro: <code>${err.message}</code>`
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

  const response = await shopifyFetch('/admin/api/2024-01/draft_orders.json', {
    method: 'POST',
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Erro ao criar encomenda: ${error}`);
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
    const draftOrderName = pi.metadata?.shopify_draft_order_name;
    const customerEmail = pi.metadata?.customer_email;
    const customerName = pi.metadata?.customer_name;
    const customerPhone = pi.metadata?.customer_phone;
    const amount = parseFloat(pi.metadata?.amount) || (pi.amount_received / 100);

    if (draftOrderId) {
      console.log(`✅ Pagamento confirmado — a completar encomenda #${draftOrderId}`);
      const order = await completeDraftOrder(draftOrderId, pi.id);

      if (order) {
        await sendFacebookPurchaseEvent({
          email: customerEmail,
          amount: amount,
          currency: pi.metadata?.currency || pi.currency,
          orderId: draftOrderId,
          orderName: order.name,
        });

        // 📱 WhatsApp → Cliente (pagamento confirmado)
        if (customerPhone) {
          await sendWhatsAppMessage(customerPhone,
            `✅ *Pagamento confirmado!*\n\n` +
            `Olá ${customerName}! A sua encomenda *${order.name}* foi confirmada! 🎉\n\n` +
            `・ Valor pago: ${formatEUR(amount)}\n\n` +
            `Vamos preparar tudo com muito carinho. 📦❤️\n\n` +
            `— Ana D'Alfama`
          );
        }

        // 📱 Telegram → Tu e amigo
        await sendTelegramMessage(
          `💰❤️ <b>CATCHIN! oldies hit different, bro</b> 💰❤️\n\n` +
          `📦 Encomenda: <b>${order.name}</b>\n` +
          `👤 Cliente: ${customerName || '—'}\n` +
          `📧 Email: ${customerEmail}\n` +
          `💰 Valor: <b>${formatEUR(amount)}</b>\n\n` +
          `✅ <i>Pagamento recebido com sucesso!</i>`
        );
      } else {
        await sendTelegramMessage(
          `💰❤️ <b>CATCHIN! oldies hit different, bro</b> 💰❤️\n\n` +
          `📦 Encomenda: ${draftOrderName || draftOrderId}\n` +
          `👤 Cliente: ${customerName || '—'}\n` +
          `📧 Email: ${customerEmail}\n` +
          `💰 Valor: <b>${formatEUR(amount)}</b>\n\n` +
          `✅ <i>Pagamento recebido com sucesso!</i>`
        );
      }
    }
  }

  res.json({ received: true });
});

async function completeDraftOrder(draftOrderId, paymentIntentId) {
  try {
    const response = await shopifyFetch(
      `/admin/api/2024-01/draft_orders/${draftOrderId}/complete.json?payment_gateway=multibanco&payment_pending=false`,
      { method: 'PUT' }
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
