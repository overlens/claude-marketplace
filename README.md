# Overlens — plugins para o Claude Code

Este repositório distribui plugins que ensinam o Claude Code a integrar
sistemas com a Overlens — você descreve o que quer em português e o assistente
cuida da parte técnica.

| Plugin | Para quê |
|---|---|
| [`idp-integration`](#idp-integration--login-da-overlens) | Conectar o **seu sistema ao login da Overlens** (SSO). |
| [`events-integration`](#events-integration--formulários-de-lead-no-events) | Fazer os **formulários das suas landing pages** enviarem os leads para o **Overlens Events**. |

## Instalação

Dentro do Claude Code, adicione o marketplace uma vez:

```
/plugin marketplace add overlens/claude-marketplace
```

E instale o(s) plugin(s) que você precisa:

```
/plugin install idp-integration@overlens
/plugin install events-integration@overlens
```

Pronto. Não há mais nada para configurar.

---

## `idp-integration` — login da Overlens

### O que é

Se você tem um site, um aplicativo ou um sistema e quer que seus usuários
entrem nele com a **conta Overlens**, este plugin dá ao Claude Code tudo o que
ele precisa para fazer essa ligação por você: guias passo a passo para cada
tipo de sistema, um assistente que faz perguntas simples (sem termos técnicos)
e a documentação oficial já embutida — o Claude Code não precisa adivinhar nada.

### Primeiro passo depois de instalar

Abra o Claude Code na pasta do seu projeto e escreva:

> quero adicionar login da Overlens no meu sistema

Ou use o comando pronto:

```
/idp-integrate
```

(o nome completo é `/idp-integration:idp-integrate` — o Claude Code completa
para você ao digitar)

O assistente vai fazer algumas perguntas simples — que tipo de sistema você
tem, qual o endereço dele — e conduzir a integração do começo ao fim, incluindo
o pedido de cadastro que você envia ao time da Overlens.

### O que o plugin contém

- **Um assistente guiado** (`idp-onboarding`) que descobre o que o seu sistema
  precisa sem exigir conhecimento técnico de você.
- **Guias especializados** para cada tipo de sistema: sites e aplicativos web,
  aplicativos de celular, serviços internos e sistemas que só conferem quem é
  o usuário.
- **Ferramentas de verificação**: testes prontos que provam que a integração
  ficou correta antes de ir ao ar.
- **A documentação oficial da Overlens embutida** — funciona até sem internet
  e nunca depende de arquivos de outro repositório.

### Sobre a versão

A versão do plugin **espelha a versão do contrato público do IDP Overlens**.
Quando o contrato muda, o plugin é atualizado junto — se a sua versão instalada
estiver atrás, rode `/plugin marketplace update overlens` e reinstale para
receber a mais recente.

O código do Identity Provider da Overlens, a documentação completa e o
histórico do contrato vivem em
[github.com/overlens/identity-provider](https://github.com/overlens/identity-provider).

---

## `events-integration` — formulários de lead no Events

### O que é

Para quem cria landing pages com o Claude Code: o plugin faz o Claude deixar o
formulário da LP **já integrado com o Overlens Events**, de onde os leads seguem
para planilha, Brevo, ManyChat, Meta etc. Funciona em qualquer tipo de projeto —
HTML puro, Next.js, Vite, Astro e outros — usando a biblioteca oficial
[`@overlens/events-sdk`](https://www.npmjs.com/package/@overlens/events-sdk).

### Primeiro passo depois de instalar

Abra o Claude Code na pasta da LP e escreva:

> integra o formulário dessa LP com o Events

Ou peça já ao criar a página ("crie a LP … com o formulário integrado ao
Events"). O Claude instala a biblioteca, liga cada formulário, adiciona a
proteção contra robôs e verifica que nada do comportamento atual quebrou.

### O que você ainda vai precisar do time do Events

Algumas informações só o time do Events tem — principalmente a **URL do
gatilho** da campanha e o **cadastro do domínio da LP**. Ao terminar, o Claude
entrega uma **mensagem pronta** para você enviar ao time, e explica onde colar a
URL quando ela chegar (e que é preciso fazer um novo deploy depois disso).

### O que o plugin contém

- **A skill `events-lead-form`**, com o passo a passo de integração, modelos de
  código para cada tipo de projeto, o modelo da mensagem para o time e um guia
  para conferir que os leads estão chegando em produção.

O código do Events e a documentação da SDK vivem em
[github.com/overlens/events](https://github.com/overlens/events).
