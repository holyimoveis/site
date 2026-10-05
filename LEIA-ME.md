# Holy: site + CRM na nuvem (Vercel)

Este pacote substitui o que está hoje no repositório **holyimoveis/site**:
- `index.html`: o site
- `crm/index.html`: o CRM, que passa a abrir em **seu-site/crm**, de qualquer computador ou celular
- `api/`: a ponte entre site, CRM, banco de dados, fotos e IA
- `vercel.json`, `package.json`, `.gitignore`: configuração

O servidor local (holy-server-v2, INICIAR_CRM.bat) deixa de ser necessário.

## Passo 1: enviar para o GitHub
1. Abra o repositório **holyimoveis/site**.
2. **Add file > Upload files**.
3. Arraste todo o conteúdo desta pasta (as pastas `api` e `crm` inteiras e os arquivos soltos). Os arquivos com o mesmo nome serão substituídos, e é isso que queremos.
4. **Commit changes**.

## Passo 2: banco de dados
Na Vercel, abra o projeto do site > **Storage > Create Database > Neon (Postgres)**, plano gratuito, região **Washington, D.C. (us-east-1)**. Conecte ao projeto.

## Passo 3: fotos
**Storage > Create > Blob**, acesso **Public**. Conecte ao projeto.

## Passo 4: senha do CRM
**Settings > Environment Variables** > adicionar **ADMIN_KEY** com uma senha forte (mínimo 12 caracteres). É com ela que você entra no CRM.

## Passo 5: chave da IA
Ainda em Environment Variables, adicione **ANTHROPIC_API_KEY** com a sua chave `sk-ant-...` (console.anthropic.com > API Keys).

## Passo 6: publicar de novo
**Deployments** > três pontinhos do último deploy > **Redeploy**.

## Passo 7: testar
- `seu-site/api/status` deve mostrar tudo "conectado"/"configurada".
- `seu-site/crm` abre a tela de senha. Entre com a ADMIN_KEY.

As variáveis antigas **CRM_API_KEY** e **KV_...** não são mais usadas e podem ser apagadas.

## Trazer os dados do CRM antigo (se houver)
1. Copie o arquivo `exportar.html` para a pasta `public` do holy-server-v2 (no seu computador).
2. Ligue o CRM antigo (INICIAR_CRM.bat) e abra **http://localhost:3000/exportar.html** no mesmo navegador que você usava.
3. Clique em **Baixar arquivo de backup**.
4. No CRM novo: **Configurações > Importar backup** e escolha o arquivo. As fotos sobem para a nuvem sozinhas.

---

## Como funciona
- **CRM**: tudo o que você salva vai para a nuvem em segundos (selo "☁ Salvo na nuvem" no canto). Sem internet, fica guardado no aparelho e sobe quando a conexão volta. Se você editar no PC e no celular ao mesmo tempo, as alterações são juntadas registro por registro. O servidor guarda as últimas 30 versões de cada lista.
- **Publicar no site**: no cadastro do imóvel, aba Básico, marque "Publicar no site". Aparece no site em até 1 minuto enquanto o status for Disponível. Rua, número, CEP e dados do proprietário nunca saem do CRM.
- **Leads**: quem preenche o formulário do site vira cliente no CRM (origem Site, etapa Prospecção) com uma nota na timeline. Cliques nos botões de WhatsApp aparecem no botão azul "🌐 interesses no site".

## Referência técnica
| Rota | Acesso | Função |
|---|---|---|
| `GET /api/imoveis` | público | imóveis do CRM com publicarSite e status Disponível (só campos de vitrine) |
| `GET/POST /api/crm` | senha | documentos do CRM (`imoveis`, `clientes`, `timeline`) com controle de versão |
| `POST /api/leads` | público | formulário e cliques de WhatsApp |
| `GET/PATCH /api/leads` | senha | CRM busca e marca leads como importados |
| `POST /api/upload` | senha | envia foto (até 4 MB) para o Blob |
| `POST /api/ia` | senha | Consultor IA (usa ANTHROPIC_API_KEY) |
| `/api/empreendimentos` | público lê, senha grava | empreendimentos do site |
| `GET /api/status` | público | diagnóstico |

## Anúncios na Meta e criador de posts (out/2026)

Arquivos: `api/meta.js` (campanhas, leads, Instagram), `api/img.js` (fotos para o criador de posts), `privacidade.html` (exigida pelos formulários de lead).

Variáveis na Vercel (Segredo, 3 ambientes):
- `META_ACCESS_TOKEN`: token do usuário do sistema (Configurações do negócio > Usuários do sistema), com as permissões ads_management, ads_read, business_management, pages_show_list, pages_read_engagement, pages_manage_ads, pages_manage_metadata, leads_retrieval, instagram_basic, instagram_content_publish.
- `META_AD_ACCOUNT_ID`: número da conta de anúncios (com ou sem "act_").
- `META_PAGE_ID`: ID da Página do Facebook da Holy.
- Opcionais: `META_IG_USER_ID` (descoberto sozinho pela Página), `META_API_VERSION` (padrão v25.0).

Regras: anúncios de imóveis sempre na Categoria Especial de Moradia (HOUSING): sem idade/gênero/CEP, sem exclusões, raio mínimo de 25 km. Campanhas são criadas PAUSADAS. Leads dos formulários entram em Clientes com origem "Meta Ads" (verificação a cada 5 minutos).

## Atualização out/2026 (2): estratégia, correções e logo
- Estratégia com IA: classifica o padrão do imóvel, define objetivo mensurável, orçamento por faixa, custo por lead e leads estimados, plano de otimização e 3 anúncios com ângulos diferentes.
- Nomes únicos de formulário e campanha; se uma etapa falhar, o que foi criado é desfeito e o erro diz a etapa.
- Leads da Meta com o nome da campanha e as respostas legíveis.
- Botão Excluir cliente (apaga também o histórico dele na Timeline).
- Página Campanhas mostra o saldo da conta de anúncios e avisa antes de ativar com saldo baixo.
- Publicação no Instagram espera cada imagem ficar pronta (corrige o erro 9007 "mídia não está pronta").
- Logo oficial da Holy (assets/holy-logo-claro.svg, holy-logo-escuro.svg, holy-coroa.svg) no CRM e nas artes.
