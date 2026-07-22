---
description: Integrar seu sistema ao login da Overlens (assistente guiado, sem jargão)
---

Conduza a integração do sistema do usuário com o login da Overlens usando a
skill `idp-onboarding` deste plugin.

1. Invoque a skill `idp-onboarding` e siga o roteiro dela do início ao fim —
   ela entrevista o usuário em linguagem de negócio (uma pergunta por vez),
   detecta a stack do projeto e roteia para a skill especialista certa.
2. Não pule o wizard: mesmo que o pedido pareça específico, deixe a
   `idp-onboarding` decidir a rota.
3. Ao final, entregue o que a skill gera: o pedido de registro de client
   pronto para enviar ao time Overlens e o checklist de prontidão para produção.

Pedido do usuário (se houver): $ARGUMENTS
