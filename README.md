# Portal confidencial Pina

Portal simples para mostrar um PDF confidencial a um cliente:

- **Senha temporária**: você gera a senha no painel, com validade de 1 a 30 dias, e envia ao cliente.
- **Aviso por e-mail a cada acesso**: data e hora (horário de Brasília), IP, cidade, provedor, se parece VPN/proxy e o dispositivo usado.
- **Registro de acessos** no painel `/admin`.
- **Sem PDF para baixar**: o PDF é convertido em imagens no seu navegador e o arquivo original nunca vai para o servidor. As páginas só aparecem com a senha, chegam embaralhadas e são desenhadas na tela com uma **marca d'água** (IP, data, hora e ID da sessão).
- **Bloqueios**: botão direito, arrastar, copiar, Ctrl+S, Ctrl+P, Ctrl+U e F12 ficam bloqueados, e a impressão sai em branco. O conteúdo some quando a janela perde o foco (por exemplo, ao abrir a ferramenta de recorte ou trocar de aba) e quando se aperta PrintScreen.
- **Custo zero**: roda no plano gratuito da Cloudflare Workers, com um endereço `https://pina-portal.SEU-NOME.workers.dev` já incluído, sem precisar comprar domínio.

> ⚠️ **Limite importante:** nenhum site consegue impedir 100% um print. Ninguém impede alguém de fotografar a tela com o celular, e no celular (iPhone/Android) o navegador não tem como bloquear o print do sistema. Por isso existe a marca d'água: se o material vazar, a imagem mostra de qual acesso ele saiu.

---

## Como colocar no ar (uma vez só, uns 15 minutos)

### 1. Criar a chave de e-mail (Resend, grátis)
1. Crie uma conta em <https://resend.com> **com o e-mail em que você quer receber os avisos**.
2. No menu **API Keys**, clique em **Create API Key**, dê um nome qualquer e copie a chave (começa com `re_`).

> No plano grátis, sem domínio próprio, o Resend só envia e-mails para o endereço da sua conta. Para este caso isso basta. Na primeira vez, olhe também a pasta de spam/lixo eletrônico.

### 2. Publicar na Cloudflare (grátis)
1. Crie uma conta em <https://dash.cloudflare.com/sign-up>. Não pede cartão.
2. No menu da esquerda, vá em **Compute (Workers)** › **Workers & Pages** › **Create** › **Import a repository**.
3. Conecte o GitHub e escolha o repositório **`grasiellyv/pina`**, na branch em que este código estiver.
4. Mantenha o que vier preenchido (deploy command: `npx wrangler deploy`) e clique em **Deploy**. O banco de dados (KV) é criado sozinho.
5. Depois do deploy, abra o Worker **pina-portal** › **Settings** › **Variables and Secrets** › **Add** e crie estes itens, **todos do tipo "Secret"**:

   | Nome | Valor |
   |---|---|
   | `ADMIN_PASSWORD` | uma senha forte **só sua**, para entrar no painel |
   | `NOTIFY_EMAIL` | o e-mail que recebe os avisos (o mesmo da conta Resend) |
   | `RESEND_API_KEY` | a chave `re_...` do passo 1 |
   | `PROXYCHECK_KEY` | *(opcional)* chave grátis de <https://proxycheck.io>, que melhora a detecção de VPN |

6. O endereço do portal aparece no topo da página do Worker, algo como `https://pina-portal.seu-nome.workers.dev`.

### 3. Usar
1. Abra `https://…workers.dev/admin` e entre com a sua `ADMIN_PASSWORD`.
2. Clique em **Testar e-mail** e confira se o aviso chegou.
3. Em **1 · Documento**, escolha o PDF e clique em **Publicar**. As páginas são convertidas e enviadas, o que leva cerca de 1 minuto.
4. Em **2 · Senha temporária**, escolha a validade e clique em **Gerar nova senha**. Copie a senha e mande para o cliente junto com o link `https://…workers.dev`. Uma cópia da senha também chega no seu e-mail.
5. A cada acesso, chega um e-mail para você, e o registro aparece em **3 · Registro de acessos**.

### 4. Tirar do ar
- **Bloquear acesso agora**: a senha para de funcionar na hora e quem estiver vendo é desconectado.
- **Apagar documento e bloquear acesso**: apaga as páginas do portal. O histórico de acessos continua no painel.
- Para remover tudo de vez: Cloudflare › Worker **pina-portal** › **Settings** › **Delete**.

---

## Detalhes técnicos
- `src/worker.js`: servidor (login, sessões assinadas com HMAC, entrega das páginas embaralhadas, registro de acessos e e-mails).
- `public/index.html`: visualizador do cliente. `public/admin.html`: painel.
- `public/vendor/`: pdf.js (Mozilla, licença Apache-2.0), usado só no painel para converter o PDF em imagens.
- Para rodar localmente: `npm install`, crie `.dev.vars` com `ADMIN_PASSWORD=...` e rode `npm run dev`.
- **Nunca coloque o PDF no repositório.** O `.gitignore` já bloqueia arquivos `*.pdf`.
