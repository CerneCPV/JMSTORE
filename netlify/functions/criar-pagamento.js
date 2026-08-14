// Netlify Function: cria uma preferência de pagamento no Mercado Pago
// e devolve o link de checkout (init_point) pro navegador redirecionar.

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      body: JSON.stringify({ error: 'Método não permitido' })
    };
  }

  try {
    const { items, pedidoId } = JSON.parse(event.body || '{}');

    if (!items || !Array.isArray(items) || items.length === 0) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Carrinho vazio' })
      };
    }

    const mpItems = items.map(i => ({
      title: String(i.nome).slice(0, 250),
      quantity: Number(i.qtd) || 1,
      unit_price: Number(i.preco),
      currency_id: 'BRL',
    }));

    const siteUrl = process.env.URL || 'https://appjm.netlify.app';

    const preference = {
      items: mpItems,

      // Liga o pagamento ao pedido criado no Supabase
      ...(pedidoId ? {
        external_reference: String(pedidoId)
      } : {}),

      back_urls: {
        success: `${siteUrl}/catalogo.html?pagamento=sucesso`,
        failure: `${siteUrl}/catalogo.html?pagamento=falhou`,
        pending: `${siteUrl}/catalogo.html?pagamento=pendente`,
      },

      auto_return: 'approved',

      // Webhook do Mercado Pago
      notification_url: `${siteUrl}/.netlify/functions/mp-webhook`,
    };

    const mpResponse = await fetch(
      'https://api.mercadopago.com/checkout/preferences',
      {
        method: 'POST',

        headers: {
          'Authorization': `Bearer ${process.env.MP_ACCESS_TOKEN}`,
          'Content-Type': 'application/json',
        },

        body: JSON.stringify(preference),
      }
    );

    const data = await mpResponse.json();

    if (!mpResponse.ok) {
      console.error('Erro Mercado Pago:', data);

      return {
        statusCode: 500,
        body: JSON.stringify({
          error:
            data.message ||
            'Erro ao criar pagamento no Mercado Pago'
        }),
      };
    }

    return {
      statusCode: 200,
      body: JSON.stringify({
        init_point: data.init_point
      }),
    };

  } catch (err) {
    console.error('Erro criar-pagamento:', err);

    return {
      statusCode: 500,
      body: JSON.stringify({
        error: err.message
      })
    };
  }
};
