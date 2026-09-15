# Holy Curadoria de Imóveis — Site Oficial 

Site de alto padrão integrado ao Holy Intelligence CRM.

## Estrutura

```
holy-site/
├── public/
│   ├── index.html      # Site principal
│   └── img/            # Imagens otimizadas
├── api/
│   ├── imoveis.js      # GET/POST/DELETE imóveis (CRM → site)
│   ├── leads.js        # POST leads (site → CRM)
│   └── status.js       # Status da API
├── vercel.json         # Configuração Vercel
└── package.json
```

## Deploy

1. Fork ou clone este repositório para a conta `holyimoveis` no GitHub
2. Conectar ao Vercel em vercel.com/new
3. Configurar variável de ambiente: `CRM_API_KEY`
4. Adicionar banco Vercel KV: Storage → Create → KV
5. Deploy automático em cada push

## Integração CRM

No Holy Intelligence CRM, em Configurações:
- **URL da API do site:** `https://holyimoveis.vercel.app`
- **Chave de API:** valor configurado em `CRM_API_KEY`

## WhatsApp

Atendimento: (49) 98845-4873
