
/**
 * k6 - SaaS Marmitaria
 * 100 usuários virtuais durante 10 minutos.
 *
 * Apenas consultas GET.
 * Não cria pedidos nem realiza pagamentos InfinitePay.
 */

import http from 'k6/http';
import { check, sleep } from 'k6';

const BASE_URL = (
  __ENV.BASE_URL || 'http://127.0.0.1:3333'
).replace(/\/+$/, '');

export const options = {
  scenarios: {
    navegacao_publica: {
      executor: 'constant-vus',
      vus: 100,
      duration: '10m',
      gracefulStop: '5s',
    },
  },

  thresholds: {
    // Menos de 2% de erros HTTP
    http_req_failed: ['rate<0.02'],

    // 95% das respostas abaixo de 2 segundos
    http_req_duration: ['p(95)<2000'],

    // Mais de 98% das verificações aprovadas
    checks: ['rate>0.98'],
  },
};

// Rotas públicas reais da Marmitaria
const pages = [
  {
    path: '/alimentos/cardapio-hoje',
    weight: 35,
  },
  {
    path: '/produtos/cardapio',
    weight: 15,
  },
  {
    path: '/marmitas-especiais',
    weight: 15,
  },
  {
    path: '/metodos-pagamentos',
    weight: 15,
  },
  {
    path: '/tamanhos-marmitas',
    weight: 10,
  },
  {
    path: '/status-loja',
    weight: 10,
  },
];

function pickPage() {
  let choice = Math.random() * 100;

  for (const page of pages) {
    choice -= page.weight;

    if (choice < 0) {
      return page;
    }
  }

  return pages[pages.length - 1];
}

export default function () {
  const page = pickPage();

  const response = http.get(
    `${BASE_URL}${page.path}`,
    {
      tags: {
        name: page.path,
      },

      timeout: '15s',
      redirects: 0,
    }
  );

  check(response, {
    'HTTP 200': (r) => r.status === 200,

    'resposta ate 2 segundos': (r) =>
      r.timings.duration < 2000,
  });

  // Simula o usuário navegando pelo cardápio
  sleep(1 + Math.random() * 3);
}
