// Netlify Function: recebe a notificação (webhook) do Mercado Pago.
//
// Fluxo:
// 1. Recebe a notificação (payment ou merchant_order — só processamos payment).
// 2. Confirma o status direto na API do Mercado Pago (nunca confia no corpo
//    da notificação).
// 3. Se aprovado, localiza o pedido no Supabase via external_reference e
//    marca como "pago" de forma atômica (PATCH condicional) — isso é o que
//    impede mandar duas mensagens se o Mercado Pago reenviar a notificação.
// 4. Avisa o dono (CallMeBot) e o cliente (CallMeBot, usando o telefone
//    salvo no pedido).
//
// Segredos usados (só em variáveis de ambiente da Netlify, nunca no
// frontend): MP_ACCESS_TOKEN, SUPABASE_SERVICE_ROLE_KEY, CALLMEBOT_PHONE,
// CALLMEBOT_APIKEY.

const SUPABASE_URL = 'https://xhvhyemebhooruvuyeiq.supabase.co';

exports.handler = async (event) => {
  // O Mercado Pago reenvia em loop se não receber 200 — por isso o handler
  // SEMPRE devolve 200, mesmo quando algo dá errado internamente. Erros só
  // são logados no console da Netlify.
  try {
    if (event.httpMethod !== 'POST' && event.httpMethod !== 'GET') {
      return { statusCode: 200, body: 'ok' };
    }

    const qs = event.queryStringParameters || {};
    let body = {};
    try { body = JSON.parse(event.body || '{}'); } catch (e) { /* corpo vazio em testes, tudo bem */ }

    const paymentId = body?.data?.id || qs['data.id'] || qs.id;
    const topic = body?.type || body?.topic || qs.type || qs.topic;

    console.log('Webhook MP recebido. topic:', topic, '| paymentId:', paymentId);

    // Só processamos notificações de pagamento. "merchant_order" e qualquer
    // outro tipo são ignorados explicitamente.
    if (topic && topic !== 'payment') {
      console.log('Notificação ignorada (não é payment):', topic);
      return { statusCode: 200, body: 'ignorado - nao e payment' };
    }
    if (!paymentId) {
      console.log('Webhook sem ID de pagamento, ignorado.');
      return { statusCode: 200, body: 'ignorado - sem id' };
    }

    // Consulta o pagamento real na API do Mercado Pago.
    const mpResp = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
      headers: { 'Authorization': `Bearer ${process.env.MP_ACCESS_TOKEN}` },
    });
    const payment = await mpResp.json();

    if (!mpResp.ok) {
      console.error('Erro ao consultar pagamento no Mercado Pago:', payment);
      return { statusCode: 200, body: 'erro ao consultar pagamento' };
    }
    if (payment.status !== 'approved') {
      console.log('Pagamento ainda não aprovado, status:', payment.status);
      return { statusCode: 200, body: 'pagamento nao aprovado' };
    }

    const pedidoId = payment.external_reference || null;
    const totalFmt = Number(payment.transaction_amount || 0).toFixed(2);

    // Dados de fallback (usados quando não tem pedido vinculado, ex: compra
    // sem login) — vêm direto do próprio Mercado Pago.
    let nomeCliente = payment.payer?.first_name
      ? `${payment.payer.first_name} ${payment.payer.last_name || ''}`.trim()
      : 'Cliente não identificado';
    let emailCliente = payment.payer?.email || null;
    let telefoneCliente = null;
    let itensTexto = formatarItensMP(payment.additional_info?.items);

    if (pedidoId) {
      const pedido = await marcarPedidoComoPago(pedidoId, paymentId);

      if (pedido === 'ja_processado') {
        console.log('Pedido', pedidoId, 'já estava pago — evitando notificação duplicada.');
        return { statusCode: 200, body: 'ja processado' };
      }

      if (pedido) {
        // Dados do próprio pedido têm prioridade (foi o que o cliente
        // realmente tinha cadastrado no momento da compra).
        if (pedido.cliente_nome) nomeCliente = pedido.cliente_nome;
        if (pedido.cliente_email) emailCliente = pedido.cliente_email;
        if (pedido.cliente_telefone) telefoneCliente = pedido.cliente_telefone;
        const itensPedidoTexto = formatarItensPedido(pedido.itens);
        if (itensPedidoTexto) itensTexto = itensPedidoTexto;
      } else {
        console.warn('pedidoId veio no pagamento mas não achei/atualizei a linha no Supabase:', pedidoId);
      }
    } else {
      console.log('Pagamento sem external_reference (provavelmente compra sem login) — sem proteção contra duplicidade nesse caso.');
    }

    // --- Avisa o dono (sempre) ---
    const textoDono =
      `✅ *NOVA VENDA APROVADA!*\n\n` +
      `Cliente: ${nomeCliente}\n` +
      `E-mail: ${emailCliente || 'não informado'}\n` +
      `Telefone: ${telefoneCliente ? normalizarTelefone(telefoneCliente) : 'não informado'}\n\n` +
      `Total: R$ ${totalFmt}\n\n` +
      `Itens:\n${itensTexto || '(sem detalhes dos itens)'}\n\n` +
      `Pagamento #${paymentId}`;

    await enviarWhatsappDono(textoDono);

    // --- Avisa o cliente (só se tiver telefone cadastrado) ---
    if (telefoneCliente) {
      const primeiroNome = nomeCliente.split(' ')[0];
      const textoCliente =
        `🎉 Olá, ${primeiroNome}!\n\n` +
        `Seu pagamento foi confirmado com sucesso.\n\n` +
        `Pedido:\n${itensTexto || '(ver detalhes na sua conta)'}\n\n` +
        `Total: R$ ${totalFmt}\n\n` +
        `Obrigado pela compra! Seu pedido já está sendo preparado.`;

      await enviarWhatsappCliente(telefoneCliente, textoCliente);
    } else {
      console.log('Cliente sem telefone cadastrado — aviso ao cliente foi pulado (pedido continua pago normalmente).');
    }

    return { statusCode: 200, body: 'ok' };
  } catch (err) {
    console.error('Erro no webhook do Mercado Pago:', err);
    return { statusCode: 200, body: 'erro tratado' };
  }
};

// ================================================================
// SUPABASE
// ================================================================

// Marca o pedido como pago de forma ATÔMICA: o filtro "status=neq.pago" faz
// o PATCH só valer se ainda não estava pago. Se o Mercado Pago reenviar a
// mesma notificação, a segunda tentativa não encontra nenhuma linha pra
// atualizar (porque já está "pago") e devolvemos 'ja_processado' — sem
// mandar mensagem de novo.
//
// Retorna: a linha atualizada (objeto), 'ja_processado', ou null em caso de
// erro/config faltando.
async function marcarPedidoComoPago(pedidoId, paymentId) {
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceKey) {
    console.error('SUPABASE_SERVICE_ROLE_KEY não configurada nas variáveis de ambiente da Netlify.');
    return null;
  }

  try {
    const url = `${SUPABASE_URL}/rest/v1/pedidos?id=eq.${encodeURIComponent(pedidoId)}&status=neq.pago`;
    const resp = await fetch(url, {
      method: 'PATCH',
      headers: {
        'apikey': serviceKey,
        'Authorization': `Bearer ${serviceKey}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=representation',
      },
      body: JSON.stringify({ status: 'pago', mp_payment_id: String(paymentId) }),
    });

    const linhas = await resp.json();

    if (!resp.ok) {
      console.error('Erro ao atualizar pedido no Supabase:', linhas);
      return null;
    }

    if (!Array.isArray(linhas) || linhas.length === 0) {
      // Ou o pedido já estava "pago" (duplicidade), ou o id não existe.
      return 'ja_processado';
    }

    return linhas[0];
  } catch (err) {
    console.error('Erro ao chamar Supabase (marcarPedidoComoPago):', err);
    return null;
  }
}

// ================================================================
// FORMATAÇÃO DE ITENS
// ================================================================

// Itens salvos no pedido do Supabase: { nome, qtd, preco }
function formatarItensPedido(itens) {
  if (!Array.isArray(itens) || itens.length === 0) return null;
  return itens
    .map(i => `• ${i.qtd}x ${i.nome} — R$ ${Number(i.preco).toFixed(2)}`)
    .join('\n');
}

// Itens que vêm da API do Mercado Pago: { title, quantity, unit_price }
function formatarItensMP(items) {
  if (!Array.isArray(items) || items.length === 0) return null;
  return items
    .map(i => `• ${i.quantity}x ${i.title} — R$ ${Number(i.unit_price).toFixed(2)}`)
    .join('\n');
}

// ================================================================
// TELEFONE
// ================================================================

// Remove tudo que não for dígito e garante o DDI 55 do Brasil.
// Ex: "(12) 99999-9999" -> "5512999999999"
function normalizarTelefone(raw) {
  if (!raw) return null;
  const digits = String(raw).replace(/\D/g, '');
  if (!digits) return null;

  // já tem DDI 55 + DDD + número (12 ou 13 dígitos)
  if (digits.startsWith('55') && (digits.length === 12 || digits.length === 13)) {
    return digits;
  }
  // número local (DDD + número, 10 ou 11 dígitos) — adiciona o DDI
  if (digits.length === 10 || digits.length === 11) {
    return '55' + digits;
  }
  // formato inesperado — devolve só os dígitos, sem inventar nada
  return digits;
}

// ================================================================
// WHATSAPP (CallMeBot)
// ================================================================

// Avisa você (dono da loja). Precisa ter ativado o CallMeBot no seu próprio
// WhatsApp uma vez (mandando mensagem pro número deles).
async function enviarWhatsappDono(texto) {
  const phone = process.env.CALLMEBOT_PHONE;
  const apikey = process.env.CALLMEBOT_APIKEY;

  if (!phone || !apikey) {
    console.error('CALLMEBOT_PHONE / CALLMEBOT_APIKEY não configurados — aviso ao dono pulado.');
    return;
  }

  await chamarCallMeBot(phone, texto, 'dono');
}

// Avisa o cliente usando o telefone salvo no Supabase.
//
// IMPORTANTE: o CallMeBot só entrega mensagem pra números que ativaram o
// bot deles mesmos (cada número precisa da própria apikey). Sem isso, essa
// chamada vai falhar silenciosamente pro CallMeBot (erro fica só no log) —
// isso é uma limitação da ferramenta, não do código. Mesmo assim, o
// pagamento continua sendo tratado como aprovado.
async function enviarWhatsappCliente(telefoneRaw, texto) {
  const telefone = normalizarTelefone(telefoneRaw);
  if (!telefone) {
    console.log('Telefone do cliente inválido após normalização, aviso pulado:', telefoneRaw);
    return;
  }

  await chamarCallMeBot(telefone, texto, 'cliente');
}

async function chamarCallMeBot(phone, texto, quem) {
  const url =
    `https://api.callmebot.com/whatsapp.php` +
    `?phone=${encodeURIComponent(phone)}` +
    `&text=${encodeURIComponent(texto)}` +
    `&apikey=${encodeURIComponent(process.env.CALLMEBOT_APIKEY)}`;

  try {
    const resp = await fetch(url);
    const resposta = await resp.text();

    if (!resp.ok) {
      console.error(`Falha ao enviar WhatsApp (${quem}) via CallMeBot:`, resp.status, resposta);
      return;
    }
    console.log(`WhatsApp (${quem}) enviado pelo CallMeBot:`, resposta);
  } catch (err) {
    // Falha no WhatsApp NUNCA deve derrubar o webhook nem afetar o
    // pagamento — só logamos.
    console.error(`Erro ao chamar CallMeBot (${quem}):`, err);
  }
}
