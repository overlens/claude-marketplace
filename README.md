# Overlens — plugins para o Claude Code

Este repositório distribui o plugin **`idp-integration`**: ele ensina o
Claude Code a conectar o **seu sistema ao login da Overlens** — você descreve o
que quer em português e o assistente cuida da parte técnica.

## O que é

Se você tem um site, um aplicativo ou um sistema e quer que seus usuários
entrem nele com a **conta Overlens**, este plugin dá ao Claude Code tudo o que
ele precisa para fazer essa ligação por você: guias passo a passo para cada
tipo de sistema, um assistente que faz perguntas simples (sem termos técnicos)
e a documentação oficial já embutida — o Claude Code não precisa adivinhar nada.

## Instalação (2 comandos)

Dentro do Claude Code, rode:

```
/plugin marketplace add overlens/claude-marketplace
/plugin install idp-integration@overlens
```

Pronto. Não há mais nada para configurar.

## Primeiro passo depois de instalar

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

## O que o plugin contém

- **Um assistente guiado** (`idp-onboarding`) que descobre o que o seu sistema
  precisa sem exigir conhecimento técnico de você.
- **Guias especializados** para cada tipo de sistema: sites e aplicativos web,
  aplicativos de celular, serviços internos e sistemas que só conferem quem é
  o usuário.
- **Ferramentas de verificação**: testes prontos que provam que a integração
  ficou correta antes de ir ao ar.
- **A documentação oficial da Overlens embutida** — funciona até sem internet
  e nunca depende de arquivos de outro repositório.

## Sobre a versão

A versão do plugin **espelha a versão do contrato público do IDP Overlens**
(hoje `1.7.0`). Quando o contrato muda, o plugin é atualizado junto — se a sua
versão instalada estiver atrás, rode `/plugin marketplace update overlens` e
reinstale para receber a mais recente.

## Saiba mais

O código do Identity Provider da Overlens, a documentação completa e o
histórico do contrato vivem em
[github.com/overlens/identity-provider](https://github.com/overlens/identity-provider).
