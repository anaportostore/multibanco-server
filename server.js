const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY, {
  apiVersion: '2024-06-20',
});
const cors = require('cors');
const crypto = require('crypto');
const { Pool } = require('pg');

const app = express();
app.use('/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());
app.use(cors());

// ===== PostgreSQL =====
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS followups (
      id SERIAL PRIMARY KEY,
      phone TEXT NOT NULL,
      customer_name TEXT,
      entity TEXT,
      reference TEXT,
      amount TEXT,
      morada TEXT,
      product_url TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      sent_20min BOOLEAN DEFAULT FALSE,
      sent_24h BOOLEAN DEFAULT FALSE,
      sent_3days BOOLEAN DEFAULT FALSE,
      paid BOOLEAN DEFAULT FALSE
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS abandoned_carts (
      id SERIAL PRIMARY KEY,
      checkout_id TEXT UNIQUE NOT NULL,
      phone TEXT NOT NULL,
      customer_name TEXT,
      email TEXT,
      morada TEXT,
      checkout_url TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      sent_20min BOOLEAN DEFAULT FALSE,
      sent_24h BOOLEAN DEFAULT FALSE,
      sent_3days BOOLEAN DEFAULT FALSE,
      converted BOOLEAN DEFAULT FALSE
    )
  `);

  console.log('✅ Base de dados pronta');
}

const FB_PIXEL_ID = '753350047833434';
const FB_ACCESS_TOKEN = process.env.FB_ACCESS_TOKEN;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const ZAPI_INSTANCE_ID = process.env.ZAPI_INSTANCE_ID;
const ZAPI_TOKEN = process.env.ZAPI_TOKEN;
const ZAPI_CLIENT_TOKEN = process.env.ZAPI_CLIENT_TOKEN;

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
  if (!ZAPI_INSTANCE_ID || !ZAPI_TOKEN) return;
  if (!phone) return;

  let number = phone.replace(/[\s\+\-]/g, '');
  if (number.startsWith('00')) number = number.slice(2);
  if (number.startsWith('9') || number.startsWith('2')) number = '351' + number;

  try {
    const response = await fetch(
      `https://api.z-api.io/instances/${ZAPI_INSTANCE_ID}/token/${ZAPI_TOKEN}/send-text`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Client-Token': ZAPI_CLIENT_TOKEN,
        },
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

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function randomDelay() {
  const delays = [5, 10, 5, 5, 10];
  const minutes = delays[Math.floor(Math.random() * delays.length)];
  return minutes * 60 * 1000;
}

function formatEUR(amount) {
  return `${parseFloat(amount).toFixed(2)} €`;
}

// ===== JOB MULTIBANCO =====
async function processFollowups() {
  try {
    const res20 = await pool.query(`
      SELECT * FROM followups
      WHERE paid = FALSE AND sent_20min = FALSE
      AND created_at <= NOW() - INTERVAL '20 minutes'
    `);
    for (const row of res20.rows) {
      await sendWhatsAppMessage(row.phone,
        `Olá ${row.customer_name}!\n\n` +
        `Obrigada pela sua encomenda na *Ana D'Alfama*! 🛍️\n\n` +
        `Para finalizar o seu pagamento use os seguintes dados:\n\n` +
        `・ Entidade: ${row.entity}\n` +
        `・ Referência: ${row.reference}\n` +
        `・ Valor: ${row.amount}\n` +
        `・ Morada: ${row.morada || '—'}\n\n` +
        `Veja aqui o seu produto:\n${row.product_url || 'https://www.anadalfama.pt'}\n\n` +
        `Qualquer dúvida estamos aqui! ❤️`
      );
      await pool.query('UPDATE followups SET sent_20min = TRUE WHERE id = $1', [row.id]);
      console.log(`✅ MB 20min → ${row.phone}`);
      await sleep(randomDelay());
    }

    const res24 = await pool.query(`
      SELECT * FROM followups
      WHERE paid = FALSE AND sent_24h = FALSE
      AND created_at <= NOW() - INTERVAL '24 hours'
    `);
    for (const row of res24.rows) {
      await sendWhatsAppMessage(row.phone,
        `Olá ${row.customer_name}!\n\n` +
        `Reparámos que ainda não finalizou o pagamento da sua encomenda na *Ana D'Alfama*.\n\n` +
        `Reservámos o seu produto mas não o conseguimos guardar para sempre! 😊\n\n` +
        `・ Entidade: ${row.entity}\n` +
        `・ Referência: ${row.reference}\n` +
        `・ Valor: ${row.amount}\n\n` +
        `Veja aqui o seu produto:\n${row.product_url || 'https://www.anadalfama.pt'}\n\n` +
        `Qualquer dúvida estamos aqui! ❤️`
      );
      await pool.query('UPDATE followups SET sent_24h = TRUE WHERE id = $1', [row.id]);
      console.log(`✅ MB 24h → ${row.phone}`);
      await sleep(randomDelay());
    }

    const res3d = await pool.query(`
      SELECT * FROM followups
      WHERE paid = FALSE AND sent_3days = FALSE
      AND created_at <= NOW() - INTERVAL '3 days'
    `);
    for (const row of res3d.rows) {
      await sendWhatsAppMessage(row.phone,
        `Olá ${row.customer_name}!\n\n` +
        `Ainda está a tempo de finalizar a sua encomenda na *Ana D'Alfama*!\n\n` +
        `Como agradecimento pela sua paciência, use o código *VOLTA10* para 10% de desconto! 💛\n\n` +
        `Veja aqui o seu produto:\n${row.product_url || 'https://www.anadalfama.pt'}\n\n` +
        `— Ana D'Alfama ❤️`
      );
      await pool.query('UPDATE followups SET sent_3days = TRUE WHERE id = $1', [row.id]);
      console.log(`✅ MB 3 dias → ${row.phone}`);
      await sleep(randomDelay());
    }

  } catch (err) {
    console.error('❌ Erro followups MB:', err.message);
  }
}

// ===== JOB CARRINHO ABANDONADO =====
async function getAbandonedCheckouts() {
  try {
    const threeWeeksAgo = new Date();
    threeWeeksAgo.setDate(threeWeeksAgo.getDate() - 21);
    const dateFilter = threeWeeksAgo.toISOString();

    const response = await shopifyFetch(
      `/admin/api/2024-01/checkouts.json?status=open&limit=250&created_at_min=${dateFilter}`
    );
    if (!response.ok) return [];
    const data = await response.json();
    return data.checkouts || [];
  } catch (err) {
    console.error('❌ Erro ao buscar checkouts:', err.message);
    return [];
  }
}

async function processAbandonedCarts() {
  try {
    const checkouts = await getAbandonedCheckouts();

    for (const checkout of checkouts) {
      const phone = checkout.shipping_address?.phone || checkout.billing_address?.phone;
      if (!phone) continue;

      const email = checkout.email || '—';
      const firstName = checkout.shipping_address?.first_name || '';
      const lastName = checkout.shipping_address?.last_name || '';
      const fullName = `${firstName} ${lastName}`.trim() || 'cliente';
      const morada = [
        checkout.shipping_address?.address1,
        checkout.shipping_address?.city,
        checkout.shipping_address?.zip,
      ].filter(Boolean).join(', ') || '—';
      const checkoutUrl = checkout.abandoned_checkout_url || 'https://www.anadalfama.pt';
      const checkoutId = checkout.id.toString();

      const mbCheck = await pool.query(
        'SELECT id FROM followups WHERE phone = $1 AND paid = FALSE',
        [phone]
      );
      if (mbCheck.rows.length > 0) continue;

      await pool.query(`
        INSERT INTO abandoned_carts (checkout_id, phone, customer_name, email, morada, checkout_url, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (checkout_id) DO NOTHING
      `, [checkoutId, phone, fullName, email, morada, checkoutUrl, new Date(checkout.created_at)]);
    }

    const res20 = await pool.query(`
      SELECT * FROM abandoned_carts
      WHERE converted = FALSE AND sent_20min = FALSE
      AND created_at <= NOW() - INTERVAL '20 minutes'
    `);
    for (const row of res20.rows) {
      await sendWhatsAppMessage(row.phone,
        `Olá ${row.customer_name}!\n\n` +
        `Já temos tudo preparado para si, só falta um clique! 🛍️\n\n` +
        `・ Nome: ${row.customer_name}\n` +
        `・ Email: ${row.email}\n` +
        `・ Morada: ${row.morada}\n\n` +
        `Veja aqui a sua encomenda:\n${row.checkout_url}\n\n` +
        `Qualquer dúvida estamos aqui! ❤️`
      );
      await pool.query('UPDATE abandoned_carts SET sent_20min = TRUE WHERE id = $1', [row.id]);
      console.log(`✅ Carrinho 20min → ${row.phone}`);
      await sleep(randomDelay());
    }

    const res24 = await pool.query(`
      SELECT * FROM abandoned_carts
      WHERE converted = FALSE AND sent_24h = FALSE
      AND created_at <= NOW() - INTERVAL '24 hours'
    `);
    for (const row of res24.rows) {
      await sendWhatsAppMessage(row.phone,
        `Olá ${row.customer_name}!\n\n` +
        `O seu carrinho na *Ana D'Alfama* ainda está à sua espera! ⏳\n\n` +
        `・ Nome: ${row.customer_name}\n` +
        `・ Email: ${row.email}\n` +
        `・ Morada: ${row.morada}\n\n` +
        `Os produtos que escolheu têm muita procura e não garantimos stock por muito mais tempo. 😊\n\n` +
        `Como agradecimento pela sua visita, use o código *VOLTA5* para 5% de desconto! 💛\n\n` +
        `Veja aqui a sua encomenda:\n${row.checkout_url}\n\n` +
        `— Ana D'Alfama ❤️`
      );
      await pool.query('UPDATE abandoned_carts SET sent_24h = TRUE WHERE id = $1', [row.id]);
      console.log(`✅ Carrinho 24h → ${row.phone}`);
      await sleep(randomDelay());
    }

    const res3d = await pool.query(`
      SELECT * FROM abandoned_carts
      WHERE converted = FALSE AND sent_3days = FALSE
      AND created_at <= NOW() - INTERVAL '3 days'
    `);
    for (const row of res3d.rows) {
      await sendWhatsAppMessage(row.phone,
        `Olá ${row.customer_name}!\n\n` +
        `Ainda está a tempo de garantir a sua encomenda na *Ana D'Alfama*! 🎁\n\n` +
        `・ Nome: ${row.customer_name}\n` +
        `・ Email: ${row.email}\n` +
        `・ Morada: ${row.morada}\n\n` +
        `Use o código *VOLTA10* para 10% de desconto! 💛\n\n` +
        `Veja aqui a sua encomenda:\n${row.checkout_url}\n\n` +
        `— Ana D'Alfama ❤️`
      );
      await pool.query('UPDATE abandoned_carts SET sent_3days = TRUE WHERE id = $1', [row.id]);
      console.log(`✅ Carrinho 3 dias → ${row.phone}`);
      await sleep(randomDelay());
    }

  } catch (err) {
    console.error('❌ Erro carrinhos abandonados:', err.message);
  }
}

// Jobs com intervalos variados
let jobIndex = 0;
const jobIntervals = [5, 10, 5, 5, 10];

function scheduleNextJob() {
  const minutes = jobIntervals[jobIndex % jobIntervals.length];
  jobIndex++;
  setTimeout(async () => {
    await processFollowups();
    await processAbandonedCarts();
    scheduleNextJob();
  }, minutes * 60 * 1000);
}

// ===== Shopify Token Management =====
const SHOPIFY_SHOP = process.env.SHOPIFY_SHOP_DOMAIN || 'vu1ntd-yz.myshopify.com';
const SHOPIFY_CLIENT_ID = process.env.SHOPIFY_CLIENT_ID;
const SHOPIFY_CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;

let shopifyTokenCache = { token: null, expires_at: 0 };
let refreshPromise = null;

async function fetchNewShopifyToken() {
  console.log('🔄 A obter novo token Shopify...');
  const response = await fetch(`https://${SHOPIFY_SHOP}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'client_credentials',
      client_id: SHOPIFY_CLIENT_ID,
      client_secret: SHOPIFY_CLIENT_SECRET,
    }),
  });
  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Falha ao obter token Shopify: ${error}`);
  }
  const data = await response.json();
  shopifyTokenCache = {
    token: data.access_token,
    expires_at: Date.now() + (data.expires_in * 1000),
  };
  console.log(`✅ Novo token Shopify obtido`);
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
    headers: { ...options.headers, 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
  });
  if (response.status === 401) {
    shopifyTokenCache.expires_at = 0;
    token = await getShopifyToken();
    response = await fetch(`https://${SHOPIFY_SHOP}${path}`, {
      ...options,
      headers: { ...options.headers, 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
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
        user_data: { em: [hashData(email)], country: [hashData('pt')] },
        custom_data: { currency: currency.toLowerCase(), value: amount, order_id: orderName || orderId },
      }],
    };
    const response = await fetch(
      `https://graph.facebook.com/v19.0/${FB_PIXEL_ID}/events?access_token=${FB_ACCESS_TOKEN}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(eventData) }
    );
    const result = await response.json();
    if (result.error) console.error('❌ Facebook CAPI erro:', result.error.message);
    else console.log(`✅ Facebook Purchase enviado — order ${orderName}`);
  } catch (err) {
    console.error('❌ Erro Facebook:', err.message);
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
        customer_email,
        customer_name: customer_name || '',
        customer_phone: address?.phone || '',
        product_url: product_url || 'https://www.anadalfama.pt',
        amount,
        currency,
        shop: 'anadalfama.pt',
      },
    });

    const mb = paymentIntent.next_action?.multibanco_display_details;
    if (!mb) throw new Error('Multibanco não ativado na Stripe.');

    const morada = [address?.address1, address?.city, address?.zip].filter(Boolean).join(', ');

    if (address?.phone) {
      await pool.query(`
        INSERT INTO followups (phone, customer_name, entity, reference, amount, morada, product_url)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
      `, [
        address.phone,
        customer_name || '',
        mb.entity,
        mb.reference,
        formatEUR(amount),
        morada,
        product_url || 'https://www.anadalfama.pt',
      ]);

      await pool.query(
        'UPDATE abandoned_carts SET converted = TRUE WHERE phone = $1',
        [address.phone]
      );
    }

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
      amount,
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
  const lineItems = cart_items?.map(item => ({ variant_id: item.variant_id, quantity: item.quantity })) || [];

  const body = {
    draft_order: {
      line_items: lineItems,
      customer: { email: customer_email },
      shipping_address: {
        first_name: firstName, last_name: lastName,
        address1: address?.address1 || '', city: address?.city || '',
        zip: address?.zip || '', country: address?.country || 'PT', phone: address?.phone || '',
      },
      billing_address: {
        first_name: firstName, last_name: lastName,
        address1: address?.address1 || '', city: address?.city || '',
        zip: address?.zip || '', country: address?.country || 'PT',
      },
      shipping_line: { title: 'Envio Standard', price: '0.00', code: 'envio-standard' },
      tags: 'multibanco,aguarda-pagamento',
      note: 'Pagamento por Multibanco — aguarda confirmação',
    }
  };

  const response = await shopifyFetch('/admin/api/2024-01/draft_orders.json', {
    method: 'POST', body: JSON.stringify(body),
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

    if (customerPhone) {
      await pool.query('UPDATE followups SET paid = TRUE WHERE phone = $1 AND paid = FALSE', [customerPhone]);
      await pool.query('UPDATE abandoned_carts SET converted = TRUE WHERE phone = $1', [customerPhone]);
    }

    if (draftOrderId) {
      const order = await completeDraftOrder(draftOrderId, pi.id);

      if (order) {
        await sendFacebookPurchaseEvent({
          email: customerEmail, amount, currency: pi.metadata?.currency || pi.currency,
          orderId: draftOrderId, orderName: order.name,
        });

        if (customerPhone) {
          await sendWhatsAppMessage(customerPhone,
            `✅ *Pagamento confirmado!*\n\n` +
            `Olá ${customerName}! A sua encomenda *${order.name}* foi confirmada! 🎉\n\n` +
            `・ Valor pago: ${formatEUR(amount)}\n\n` +
            `Vamos preparar tudo com muito carinho. 📦❤️\n\n` +
            `— Ana D'Alfama`
          );
        }

        await sendTelegramMessage(
          `💰 <b>MOONEY! Pagamento realizado.</b>\n\n` +
          `📦 Encomenda: <b>${order.name}</b>\n` +
          `👤 Cliente: ${customerName || '—'}\n` +
          `📧 Email: ${customerEmail}\n` +
          `💰 Valor: <b>${formatEUR(amount)}</b>\n\n` +
          `✅ <i>Pagamento recebido com sucesso!</i>`
        );
      } else {
        await sendTelegramMessage(
          `💰 <b>MOONEY! Pagamento realizado.</b>\n\n` +
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
app.listen(PORT, async () => {
  console.log(`🚀 Porta ${PORT}`);
  await initDB();
  await processFollowups();
  await processAbandonedCarts();
  scheduleNextJob();
});
