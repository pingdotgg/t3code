# T3 Parade: instalar o fork integrado

Este fork reúne a interface personalizada e o painel de verificação no código do T3 Code. O repositório público é [joaokhalaf/t3code](https://github.com/joaokhalaf/t3code). A licença MIT e os avisos de terceiros do projeto original continuam válidos, inclusive para uso no trabalho.

## Instalar pelo código-fonte

Tenha Git e Vite+ (`vp`) instalados no Linux ou WSL. Use a versão de Node indicada em `package.json`; o Vite+ gerencia o runtime. Instale e autentique os CLIs de agentes que pretende usar nessa máquina separadamente.

```sh
git clone --branch parade https://github.com/joaokhalaf/t3code.git t3-parade
cd t3-parade
vp i
vp run dev --home-dir "$PWD/.t3" --no-seed
```

Abra a URL de pareamento exibida no terminal. Ela é uma credencial temporária: não a publique. O servidor e a interface vêm deste checkout. O diretório `.t3` guarda o estado desta instalação; `--no-seed` inicia sem copiar conversas da instalação habitual. Mantenha o terminal aberto durante o uso.

Para atualizar, encerre o servidor, execute `git pull --ff-only` e `vp i`, depois repita o comando de execução. Faça backup do estado com o servidor parado antes de atualizar. Não copie `.t3`, `.env`, tokens ou perfis de navegador para o repositório.

## Windows com WSL

O [inicializador Windows](windows-fork.md) abre a interface deste checkout na janela nativa do T3 Code instalado no Windows. Esse modo requer o aplicativo original já instalado e usa o backend que ele fornece. Ele não é um instalador independente. Para executar frontend e backend deste fork juntos, use o comando acima e abra a interface no navegador do Windows.

## O que está integrado

- Lista lateral contínua de conversas, com estado e ações preservados.
- Abas de sessões do projeto, navegação **Needs you** e painel lateral de detalhes.
- Contexto e uso conforme informado pelo provedor; verificações de PR e chamadas MCP quando há dados registrados.
- [Verificação de alterações](../user/verification.md): solicitação explícita ao agente atual, resultados de comandos e relatório com links para evidências. Concluir uma execução não significa aprovar todos os fluxos. Código de saída ausente aparece como não confirmado.
- Traduções da interface em todos os idiomas já suportados pelo cliente web.

A interface compartilhada atende web e desktop. O aplicativo móvel separado mantém a interface original. Serviços de nuvem, assinaturas e credenciais não são incluídos no fork. Os modelos mantêm seus custos e limites habituais.

## Validação

Antes de enviar alterações, execute `vp run check:changed`. Os testes do painel ficam em `apps/web/src/components/chat/threadVerification.logic.test.ts` e `VerificationPanel.browser.test.tsx`. Para testar apenas esses arquivos, execute `vp test run` com os dois caminhos a partir de `apps/web`.

Os testes de navegador precisam das bibliotecas de sistema do Chromium. A documentação de desenvolvimento do projeto descreve os pré-requisitos. Não use a ausência de evidência como resultado aprovado.
