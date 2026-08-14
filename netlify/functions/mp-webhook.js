// ============================================================
// WEBHOOK DO MERCADO PAGO
// ============================================================
//
// Recebe notificações do Mercado Pago,
// consulta o pagamento diretamente na API,
// verifica se está aprovado,
// atualiza o pedido no Supabase
// e envia uma mensagem pelo CallMeBot.
//
// ============================================================


const SUPABASE_URL =
  'https://xhvhyemebhooruvuyeiq.supabase.co';


exports.handler = async (event) => {

  /*
   * O Mercado Pago pode enviar POST ou GET.
   * Respondemos 200 para evitar reenvios desnecessários.
   */

  try {

    if (
      event.httpMethod !== 'POST' &&
      event.httpMethod !== 'GET'
    ) {

      return {
        statusCode: 200,
        body: 'ok'
      };

    }


    /*
     * ========================================================
     * 1. LÊ A NOTIFICAÇÃO
     * ========================================================
     */

    const qs =
      event.queryStringParameters || {};

    let body = {};

    try {

      body =
        JSON.parse(event.body || '{}');

    } catch (e) {

      body = {};

    }


    /*
     * ID do pagamento
     *
     * Pode vir em:
     *
     * body.data.id
     * query data.id
     * query id
     */

    const paymentId =
      body?.data?.id ||
      qs['data.id'] ||
      qs.id;


    /*
     * Tipo da notificação
     */

    const topic =
      body?.type ||
      body?.topic ||
      qs.type ||
      qs.topic;


    /*
     * Ignora notificações que não sejam de pagamento
     */

    if (
      !paymentId ||
      (topic && topic !== 'payment')
    ) {

      return {
        statusCode: 200,
        body: 'ignorado'
      };

    }


    console.log(
      'Webhook recebido. Pagamento:',
      paymentId
    );


    /*
     * ========================================================
     * 2. CONSULTA O PAGAMENTO DIRETAMENTE NO MERCADO PAGO
     * ========================================================
     */

    const mpResp = await fetch(
      `https://api.mercadopago.com/v1/payments/${paymentId}`,
      {
        headers: {
          'Authorization':
            `Bearer ${process.env.MP_ACCESS_TOKEN}`
        }
      }
    );


    const payment =
      await mpResp.json();


    if (!mpResp.ok) {

      console.error(
        'Erro ao consultar pagamento:',
        payment
      );

      return {
        statusCode: 200,
        body: 'erro consulta pagamento'
      };

    }


    /*
     * ========================================================
     * 3. SÓ CONTINUA SE ESTIVER APROVADO
     * ========================================================
     */

    if (
      !payment ||
      payment.status !== 'approved'
    ) {

      console.log(
        'Pagamento ainda não aprovado:',
        payment?.status
      );

      return {
        statusCode: 200,
        body: 'status nao aprovado'
      };

    }


    console.log(
      'Pagamento aprovado:',
      paymentId
    );


    /*
     * ========================================================
     * 4. PEGA O ID DO PEDIDO
     * ========================================================
     */

    const pedidoId =
      payment.external_reference ||
      null;


    /*
     * ========================================================
     * 5. ATUALIZA O PEDIDO NO SUPABASE
     * ========================================================
     */

    let cliente = null;

    if (pedidoId) {

      cliente =
        await atualizarPedido(pedidoId);

    }


    /*
     * ========================================================
     * 6. MONTA OS DADOS DA VENDA
     * ========================================================
     */

    const itens =
      (payment.additional_info?.items || [])
        .map(i =>
          `• ${i.quantity}x ${i.title} — R$ ${Number(i.unit_price).toFixed(2)}`
        )
        .join('\n');


    const total =
      Number(
        payment.transaction_amount || 0
      ).toFixed(2);


    const nomeCliente =
      cliente?.nome ||
      (
        payment.payer?.first_name
          ? `${payment.payer.first_name} ${payment.payer.last_name || ''}`.trim()
          : payment.payer?.email ||
            'Cliente não identificado'
      );


    /*
     * ========================================================
     * 7. MONTA A MENSAGEM
     * ========================================================
     */

    const texto =
      `✅ *NOVA VENDA APROVADA!*\n\n` +

      `👤 Cliente: ${nomeCliente}\n` +

      `💰 Total: R$ ${total}\n\n` +

      `🛒 Itens:\n` +

      `${itens || '(sem detalhe dos itens)'}\n\n` +

      `💳 Pagamento: #${paymentId}`;


    /*
     * ========================================================
     * 8. ENVIA WHATSAPP
     * ========================================================
     */

    await enviarWhatsapp(texto);


    /*
     * ========================================================
     * 9. FINALIZA
     * ========================================================
     */

    return {
      statusCode: 200,
      body: 'ok'
    };


  } catch (err) {

    console.error(
      'Erro no webhook do Mercado Pago:',
      err
    );


    /*
     * Mesmo com erro interno,
     * respondemos 200 para evitar
     * reenvios excessivos do Mercado Pago.
     */

    return {
      statusCode: 200,
      body: 'erro tratado'
    };

  }

};



/*
 * ============================================================
 * ATUALIZA PEDIDO NO SUPABASE
 * ============================================================
 */

async function atualizarPedido(pedidoId) {

  const serviceKey =
    process.env.SUPABASE_SERVICE_ROLE_KEY;


  /*
   * Se ainda não configurou essa variável,
   * simplesmente não atualiza o pedido.
   */

  if (!serviceKey) {

    console.error(
      'SUPABASE_SERVICE_ROLE_KEY não configurada.'
    );

    return null;

  }


  try {

    /*
     * Atualiza status para pago
     */

    const patchResp =
      await fetch(
        `${SUPABASE_URL}/rest/v1/pedidos?id=eq.${encodeURIComponent(pedidoId)}`,
        {
          method: 'PATCH',

          headers: {
            'apikey': serviceKey,

            'Authorization':
              `Bearer ${serviceKey}`,

            'Content-Type':
              'application/json',

            'Prefer':
              'return=representation',
          },

          body: JSON.stringify({
            status: 'pago'
          }),
        }
      );


    const linhas =
      await patchResp.json();


    if (!patchResp.ok) {

      console.error(
        'Erro ao atualizar pedido:',
        linhas
      );

      return null;

    }


    const pedido =
      Array.isArray(linhas)
        ? linhas[0]
        : null;


    if (!pedido) {

      console.error(
        'Pedido não encontrado:',
        pedidoId
      );

      return null;

    }


    /*
     * Se tiver user_id,
     * buscamos os dados do cliente.
     */

    if (!pedido.user_id) {

      return null;

    }


    const userResp =
      await fetch(
        `${SUPABASE_URL}/auth/v1/admin/users/${pedido.user_id}`,
        {
          headers: {
            'apikey': serviceKey,

            'Authorization':
              `Bearer ${serviceKey}`,
          }
        }
      );


    const user =
      await userResp.json();


    if (!userResp.ok) {

      return null;

    }


    return {

      nome:
        user.user_metadata?.full_name ||
        user.user_metadata?.name ||
        null,

      telefone:
        user.user_metadata?.phone ||
        null

    };


  } catch (err) {

    console.error(
      'Erro ao atualizar pedido:',
      err
    );

    return null;

  }

}



/*
 * ============================================================
 * ENVIA WHATSAPP PELO CALLMEBOT
 * ============================================================
 */

async function enviarWhatsapp(texto) {

  const phone =
    process.env.CALLMEBOT_PHONE;


  const apikey =
    process.env.CALLMEBOT_APIKEY;


  if (!phone || !apikey) {

    console.error(
      'CALLMEBOT_PHONE / CALLMEBOT_APIKEY não configurados.'
    );

    return;

  }


  const url =
    `https://api.callmebot.com/whatsapp.php` +

    `?phone=${encodeURIComponent(phone)}` +

    `&text=${encodeURIComponent(texto)}` +

    `&apikey=${encodeURIComponent(apikey)}`;


  try {

    const resp =
      await fetch(url);


    const resposta =
      await resp.text();


    if (!resp.ok) {

      console.error(
        'Falha ao enviar WhatsApp via CallMeBot:',
        resp.status,
        resposta
      );

      return;

    }


    console.log(
      'WhatsApp enviado pelo CallMeBot:',
      resposta
    );


  } catch (err) {

    console.error(
      'Erro ao chamar CallMeBot:',
      err
    );

  }

}
