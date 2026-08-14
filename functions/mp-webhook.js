// Netlify Function: recebe a notificação (webhook) do Mercado Pago quando
// um pagamento é criado/atualizado. Confirma o status direto na API do MP
// (nunca confia nos dados que vêm no corpo da notificação), atualiza o
// pedido no Supabase e manda WhatsApp pra você e pro cliente.

const SUPABASE_URL = 'https://xhvhyemebhooruvuyeiq.supabase.co';

exports.handler = async (event) => {
  // O Mercado Pago reenvia em loop se não receber 200, então SEMPRE
  // devolvemos 200 — erros são só logados, nunca propagados como falha.
  try {
    if (event.httpMethod !== 'POST' && event.httpMethod !== 'GET') {
      return { statusCode: 200, body: 'ok' };
    }

    const qs = event.queryStringParameters || {};
    let body = {};
    try { body = JSON.parse(event.body || '{}'); } catch (e) { /* pode vir vazio em teste */ }

    const paymentId = body?.data?.id || qs['data.id'] || qs.id;
    const topic = body?.type || body?.topic || qs.type || qs.topic;

    if (!paymentId || (topic && topic !== 'payment')) {
      return { statusCode: 200, body: 'ignorado' };
    }

    // Busca os dados reais do pagamento na API do Mercado Pago — é o único
    // jeito confiável de saber o status.
    const mpResp = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
      headers: { 'Authorization': `Bearer ${process.env.MP_ACCESS_TOKEN}` },
    });
    const payment = await mpResp.json();

    if (!mpResp.ok || !payment || payment.status !== 'approved') {
      return { statusCode: 200, body: 'status nao aprovado, ignorado' };
    }

    const itensTexto = (payment.additional_info?.items || [])
      .map(i => `• ${i.quantity}x ${i.title} — R$ ${Number(i.unit_price).toFixed(2)}`)
      .join('\n');
    const total = Number(payment.transaction_amount || 0).toFixed(2);
    const pedidoId = payment.external_reference || null;

    let nomeCliente = payment.payer?.first_name
      ? `${payment.payer.first_name} ${payment.payer.last_name || ''}`.trim()
      : (payment.payer?.email || 'Cliente não identificado');
    let telefoneCliente = null;

    // Se o pedido tem referência (cliente estava logado), atualiza o
    // status no Supabase e busca o telefone dele pra avisar.
    if (pedidoId) {
      const resultado = await atualizarPedidoEBuscarCliente(pedidoId);
      if (resultado?.nome) nomeCliente = resultado.nome;
      if (resultado?.telefone) telefoneCliente = resultado.telefone;
    }

    const textoDono =
      `✅ *Nova venda aprovada!*\n\n` +
      `Cliente: ${nomeCliente}\n` +
      `Total: R$ ${total}\n\n` +
      `Itens:\n${itensTexto || '(sem detalhe de itens)'}\n\n` +
      `Pagamento #${paymentId}`;
    await enviarWhatsappDono(textoDono);

    if (telefoneCliente) {
      const textoCliente =
        `Oi, ${nomeCliente.split(' ')[0]}! 🎉\n\n` +
        `Recebemos seu pagamento de R$ ${total} confirmado.\n\n` +
        `Itens:\n${itensTexto || '(ver detalhes na sua conta)'}\n\n` +
        `Já vamos preparar seu pedido. Qualquer dúvida é só chamar por aqui!`;
      await enviarWhatsappCliente(telefoneCliente, textoCliente);
    }

    return { statusCode: 200, body: 'ok' };
  } catch (err) {
    console.error('Erro no webhook do Mercado Pago:', err);
    return { statusCode: 200, body: 'erro tratado' };
  }
};

// Atualiza o status do pedido pra "pago" no Supabase e devolve nome/telefone
// do cliente (guardados no cadastro dele) pra usar na mensagem.
async function atualizarPedidoEBuscarCliente(pedidoId) {
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceKey) {
    console.error('SUPABASE_SERVICE_ROLE_KEY não configurada nas variáveis de ambiente da Netlify.');
    return null;
  }

  try {
    // Atualiza o pedido e já pede de volta a linha atualizada (com user_id).
    const patchResp = await fetch(`${SUPABASE_URL}/rest/v1/pedidos?id=eq.${encodeURIComponent(pedidoId)}`, {
      method: 'PATCH',
      headers: {
        'apikey': serviceKey,
        'Authorization': `Bearer ${serviceKey}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=representation',
      },
      body: JSON.stringify({ status: 'pago' }),
    });
    const linhas = await patchResp.json();
    const pedido = Array.isArray(linhas) ? linhas[0] : null;
    if (!patchResp.ok || !pedido?.user_id) return null;

    // Busca o usuário no Supabase Auth pra pegar nome e telefone do cadastro.
    const userResp = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${pedido.user_id}`, {
      headers: {
        'apikey': serviceKey,
        'Authorization': `Bearer ${serviceKey}`,
      },
    });
    const user = await userResp.json();
    if (!userResp.ok || !user) return null;

    return {
      nome: user.user_metadata?.full_name || user.user_metadata?.name || null,
      telefone: user.user_metadata?.phone || null,
    };
  } catch (err) {
    console.error('Erro ao atualizar pedido/buscar cliente no Supabase:', err);
    return null;
  }
}

// Avisa você (dono da loja) via CallMeBot — precisa ativar uma vez mandando
// mensagem pro número do CallMeBot no seu próprio WhatsApp.
async function enviarWhatsappDono(texto) {
  const phone = process.env.CALLMEBOT_PHONE;
  const apikey = process.env.CALLMEBOT_APIKEY;
  if (!phone || !apikey) {
    console.error('CALLMEBOT_PHONE / CALLMEBOT_APIKEY não configurados.');
    return;
  }
  const url = `https://api.callmebot.com/whatsapp.php?phone=${encodeURIComponent(phone)}&text=${encodeURIComponent(texto)}&apikey=${encodeURIComponent(apikey)}`;
  const resp = await fetch(url);
  if (!resp.ok) console.error('Falha ao enviar WhatsApp (dono):', resp.status, await resp.text());
}

// Avisa o cliente via Z-API — manda de qualquer número da sua instância pra
// qualquer WhatsApp, sem precisar que o cliente ative nada antes.
async function enviarWhatsappCliente(telefone, texto) {
  const instanceId = process.env.ZAPI_INSTANCE_ID;
  const token = process.env.ZAPI_TOKEN;
  const clientToken = process.env.ZAPI_CLIENT_TOKEN; // opcional, depende da conta

  if (!instanceId || !token) {
    console.error('ZAPI_INSTANCE_ID / ZAPI_TOKEN não configurados — aviso ao cliente pulado.');
    return;
  }

  const numero = telefone.replace(/\D/g, ''); // só dígitos, com DDI
  const url = `https://api.z-api.io/instances/${instanceId}/token/${token}/send-text`;

  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(clientToken ? { 'Client-Token': clientToken } : {}),
      },
      body: JSON.stringify({ phone: numero, message: texto }),
    });
    if (!resp.ok) console.error('Falha ao enviar WhatsApp (cliente):', resp.status, await resp.text());
  } catch (err) {
    console.error('Erro ao chamar Z-API:', err);
  }
}
