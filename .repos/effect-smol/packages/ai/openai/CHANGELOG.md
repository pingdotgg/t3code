# @effect/ai-openai

## 4.0.0-beta.102

### Patch Changes

- [#6608](https://github.com/Effect-TS/effect/pull/6608) [`0e50ec7`](https://github.com/Effect-TS/effect/commit/0e50ec7dbb94390666f292cf9120719bf30a7246) Thanks @gcanti! - Add `Schema.Natural` for non-negative safe integers and use canonical `Schema.Int`, `Schema.Finite`, and `Schema.Natural` schemas for numeric domain values across Effect, AI protocols, and OpenAPI patches.

  Update the date, date-time, file, time-zone, cluster, event-log, persistence, socket, SQL, and DevTools schemas to reject invalid non-finite or non-integer values where appropriate. Correct the decoded schema of `Schema.NumberFromString`, and allow `Schema.DurationFromMillis` and `Schema.DurationFromNanos` to represent negative durations.

- [#6650](https://github.com/Effect-TS/effect/pull/6650) [`acd385e`](https://github.com/Effect-TS/effect/commit/acd385ebb3f9edee37ab6715607119ee9762a615) Thanks @IMax153! - Redact OpenAI organization and project headers from client errors.

- [#6549](https://github.com/Effect-TS/effect/pull/6549) [`64c6ab1`](https://github.com/Effect-TS/effect/commit/64c6ab1951ac6fb0bdd5e0398795946dc2872be7) Thanks @xianjianlf2! - Encode OpenAI Responses API system messages as typed input text content.

- [#6567](https://github.com/Effect-TS/effect/pull/6567) [`5101e92`](https://github.com/Effect-TS/effect/commit/5101e92c9c149c153423f43dd7a94f6194653c06) Thanks @gcanti! - Add `Record.assignProperty` and safely handle dynamic record keys such as `__proto__` and inherited property names.

- Updated dependencies [[`b6392e1`](https://github.com/Effect-TS/effect/commit/b6392e119704553edec1b4fd2869ac0dbec621ef), [`7ed9450`](https://github.com/Effect-TS/effect/commit/7ed945044eb56aa9aeaf62d4746a011c96c58628), [`45762bd`](https://github.com/Effect-TS/effect/commit/45762bd78df9ecd87c98b8d3738cdeeac7d81128), [`a6e8391`](https://github.com/Effect-TS/effect/commit/a6e8391cd31acd898fae18b3f8e7ca4c6f14f065), [`4ac7e8b`](https://github.com/Effect-TS/effect/commit/4ac7e8b136c61a26c3e438c013dfd7349b38e999), [`4cd40f5`](https://github.com/Effect-TS/effect/commit/4cd40f5692477783bef84fed3c5ef1c0cf5602e6), [`6956bc0`](https://github.com/Effect-TS/effect/commit/6956bc0e6cb27f53fbec39d9b18545940f9f598f), [`0e50ec7`](https://github.com/Effect-TS/effect/commit/0e50ec7dbb94390666f292cf9120719bf30a7246), [`9fcdade`](https://github.com/Effect-TS/effect/commit/9fcdade4a8af772b9ccd8b8a24fe8cee0e5d8470), [`57367d5`](https://github.com/Effect-TS/effect/commit/57367d54de55047ff0c5fce9685475e236bf354c), [`35c445f`](https://github.com/Effect-TS/effect/commit/35c445ff18029d192900ea0914c993f58d5cf1a5), [`c917bb9`](https://github.com/Effect-TS/effect/commit/c917bb94a4c1c4e0a24372a8ebb8a5ca232e36b5), [`bc1f358`](https://github.com/Effect-TS/effect/commit/bc1f3583e63344cb2c398d9040d9c975488ed123), [`0e0c9d7`](https://github.com/Effect-TS/effect/commit/0e0c9d7922ff463c1093d9e0576fae12cb0698d5), [`73d40aa`](https://github.com/Effect-TS/effect/commit/73d40aacd8fcae1b48c23f5b0a5c542127401d1d), [`4f1e318`](https://github.com/Effect-TS/effect/commit/4f1e3183f7123591c46224e9c587df7594562a5f), [`9d8d85c`](https://github.com/Effect-TS/effect/commit/9d8d85c1bb7da51970845b8ea830e386e777514a), [`6079fda`](https://github.com/Effect-TS/effect/commit/6079fda7b02f2f01ad91c15ab8c307336f3ba252), [`5101e92`](https://github.com/Effect-TS/effect/commit/5101e92c9c149c153423f43dd7a94f6194653c06), [`d0b3265`](https://github.com/Effect-TS/effect/commit/d0b3265c3262670761471ab3518cf933b1b3b20a), [`7a03c89`](https://github.com/Effect-TS/effect/commit/7a03c893ce6492bf94c0ebfb00b63bf25dcbf83e), [`cea1d9c`](https://github.com/Effect-TS/effect/commit/cea1d9c92601e69ebda040af8a1d860d604d885c), [`078e1f5`](https://github.com/Effect-TS/effect/commit/078e1f5636e31b76a86722a636afc37a8cc25580), [`97bafea`](https://github.com/Effect-TS/effect/commit/97bafeab460833b9781527b437d1cb9cbee63260), [`fab0ab8`](https://github.com/Effect-TS/effect/commit/fab0ab8f7ab15ae596faa4ccf75615a494d11b0b), [`c323d8b`](https://github.com/Effect-TS/effect/commit/c323d8b30dbbe85f9df25b67288b93d5332de333), [`6966353`](https://github.com/Effect-TS/effect/commit/69663534d626003eb10a5e55ab1f13e0379fead1), [`0444004`](https://github.com/Effect-TS/effect/commit/04440041989c1785fe4db286379f2be2c15baa85), [`028bbb3`](https://github.com/Effect-TS/effect/commit/028bbb391e161185da10d974ab33381f769940d7), [`ff5d6e2`](https://github.com/Effect-TS/effect/commit/ff5d6e278a1fdff714315dc1a17075012f05c1f0), [`1bfce93`](https://github.com/Effect-TS/effect/commit/1bfce93e6d2bf0794c11733daf51c2390e7de375), [`7ce815c`](https://github.com/Effect-TS/effect/commit/7ce815cd5af6af991dfc13b890fd22345fc77c20), [`7271a7f`](https://github.com/Effect-TS/effect/commit/7271a7faf1080aa75f2f53ca6a0b5ec9334c1d38), [`475fe5c`](https://github.com/Effect-TS/effect/commit/475fe5c12c2d6504c475797c0634f90da01e1797)]:
  - effect@4.0.0-beta.102

## 4.0.0-beta.101

### Patch Changes

- [#6519](https://github.com/Effect-TS/effect/pull/6519) [`0e116a1`](https://github.com/Effect-TS/effect/commit/0e116a139c9d7af7c7e0ccbb7b5669926477370e) Thanks @tim-smart! - Preserve OpenAI Responses API cache write token usage in language model responses.

- Updated dependencies [[`731bea1`](https://github.com/Effect-TS/effect/commit/731bea19416755a904ff5e809413e5922785d0a4), [`731bea1`](https://github.com/Effect-TS/effect/commit/731bea19416755a904ff5e809413e5922785d0a4), [`731bea1`](https://github.com/Effect-TS/effect/commit/731bea19416755a904ff5e809413e5922785d0a4), [`731bea1`](https://github.com/Effect-TS/effect/commit/731bea19416755a904ff5e809413e5922785d0a4), [`731bea1`](https://github.com/Effect-TS/effect/commit/731bea19416755a904ff5e809413e5922785d0a4), [`b35ed29`](https://github.com/Effect-TS/effect/commit/b35ed2904f01536d303b21f288daf343cf740462), [`dd44624`](https://github.com/Effect-TS/effect/commit/dd446245736a0e88c807a02f03c21450bb9340fa), [`731bea1`](https://github.com/Effect-TS/effect/commit/731bea19416755a904ff5e809413e5922785d0a4), [`2bae1ac`](https://github.com/Effect-TS/effect/commit/2bae1accce9d3b72cf6d5aefc9b2161af6d88436)]:
  - effect@4.0.0-beta.101

## 4.0.0-beta.100

### Patch Changes

- Updated dependencies [[`c1288dd`](https://github.com/Effect-TS/effect/commit/c1288dd1a52a2811ab7df57fc4ce236c6be4c745), [`2b58a3d`](https://github.com/Effect-TS/effect/commit/2b58a3dab6bc99776dddaf76e27d811e0f47f3d8), [`6dc83f2`](https://github.com/Effect-TS/effect/commit/6dc83f26ddf20d48db28cf761dd8f3716e5273fb), [`c1e2fe0`](https://github.com/Effect-TS/effect/commit/c1e2fe0cf93564f4d919e3998874c3e70b0cf30f), [`f3fbae8`](https://github.com/Effect-TS/effect/commit/f3fbae8d7bae0d77cb4f35a1598b26c58e3bf94d), [`e000f80`](https://github.com/Effect-TS/effect/commit/e000f80fd55bcd8edc699fdbf4cd109004f4f754), [`f4ee765`](https://github.com/Effect-TS/effect/commit/f4ee7655ee052cf9ba726fd602bb87c89c7c62a9), [`510b55f`](https://github.com/Effect-TS/effect/commit/510b55f3e21750685dbfd5f476a130c1c5af9dbd), [`31d3fc4`](https://github.com/Effect-TS/effect/commit/31d3fc4327c50867bb8d881fa7353aeb03ea2826), [`875e618`](https://github.com/Effect-TS/effect/commit/875e618c3764a7b817ac863d0af86924449528f2), [`688d46a`](https://github.com/Effect-TS/effect/commit/688d46afd0ef923d983ad3d7385f52f217b28d70), [`6ff5023`](https://github.com/Effect-TS/effect/commit/6ff502363b9840a5a5ee0a24bc6cae734ac3a3eb), [`c0333e7`](https://github.com/Effect-TS/effect/commit/c0333e7f755f42ddcca7051e029da8b4eed527bf), [`06e7e8c`](https://github.com/Effect-TS/effect/commit/06e7e8c66015ee318f871b9d2218dee82df2b108), [`eb9b102`](https://github.com/Effect-TS/effect/commit/eb9b10256c8558881b441c2fef833b7037174400), [`8b155da`](https://github.com/Effect-TS/effect/commit/8b155da06e0740c354ec562957a45ab65eb4573b), [`3a87335`](https://github.com/Effect-TS/effect/commit/3a8733564c5db35271aa20564ed0d344daa2a79f)]:
  - effect@4.0.0-beta.100

## 4.0.0-beta.99

### Patch Changes

- Updated dependencies [[`8ce4795`](https://github.com/Effect-TS/effect/commit/8ce4795ccbaebca4292757db568c005a992546a4), [`80b539f`](https://github.com/Effect-TS/effect/commit/80b539f8aba68f478c75c35c2b4140c4ffc4fada), [`88a54cc`](https://github.com/Effect-TS/effect/commit/88a54cc341006e3ebcb13482c618f62a680ce199), [`e6e6dba`](https://github.com/Effect-TS/effect/commit/e6e6dba6e9d86e7c2ad27dcedf289db76a19697f), [`bfb203e`](https://github.com/Effect-TS/effect/commit/bfb203e95aa439f731acad37fc3a9a831a190f1c), [`2e9a34a`](https://github.com/Effect-TS/effect/commit/2e9a34ac2bece4f3a206160480c991e3841dc67a), [`55d4eb3`](https://github.com/Effect-TS/effect/commit/55d4eb34f2c64d54f6a25a305b5c5438ebd7934e), [`bddb010`](https://github.com/Effect-TS/effect/commit/bddb010eac3d4436cb094edbbee7460c5440c162), [`a328835`](https://github.com/Effect-TS/effect/commit/a328835e50d76bc96648a1c1550456e8c9f81210), [`5560d05`](https://github.com/Effect-TS/effect/commit/5560d05aa6abdd29466d9c3412cc5e648b0adbde), [`8f6e3ad`](https://github.com/Effect-TS/effect/commit/8f6e3adb185b16e8820b98c509b308086f7ff1af), [`46997fa`](https://github.com/Effect-TS/effect/commit/46997fa60401f5e3c93daa4b61f7df8e31caaab4), [`9e6e12d`](https://github.com/Effect-TS/effect/commit/9e6e12d75c118cd265496f2880490d1f33a5c8bf), [`3394b93`](https://github.com/Effect-TS/effect/commit/3394b93d97d6f24fc38670641d1490289ffca7f1), [`febeabc`](https://github.com/Effect-TS/effect/commit/febeabc3f7c31094da000a23edeaabfe2ab00a38), [`54161c9`](https://github.com/Effect-TS/effect/commit/54161c98f6f3569e0c31842f54e6a257f9421c4c), [`385f7a4`](https://github.com/Effect-TS/effect/commit/385f7a4ee4a7359928597ea56d151dbaf5eb5802), [`7eea4d0`](https://github.com/Effect-TS/effect/commit/7eea4d0b73ec554915d7066a71f46326ce2ba45f), [`7543afe`](https://github.com/Effect-TS/effect/commit/7543afea6f4d97d1f1ad876224323838a48daadd), [`44b9cf3`](https://github.com/Effect-TS/effect/commit/44b9cf3d240d726997b4bbcd0ede48e074d3c456), [`7eea4d0`](https://github.com/Effect-TS/effect/commit/7eea4d0b73ec554915d7066a71f46326ce2ba45f), [`0a8aa6a`](https://github.com/Effect-TS/effect/commit/0a8aa6acb90a72b91c24d17133c950e4cacd8abd), [`c8d9fcf`](https://github.com/Effect-TS/effect/commit/c8d9fcf7b030f7c474effbab2764ce7aee1c7209), [`9ca7f9a`](https://github.com/Effect-TS/effect/commit/9ca7f9a69363e4485645966d5a93b8f9597c5206), [`e7aca89`](https://github.com/Effect-TS/effect/commit/e7aca894bb32fbb785b5830837e6061c415a6015), [`55d7560`](https://github.com/Effect-TS/effect/commit/55d75609b8acf8a1b54c1b1c7fbbb65ec741aa3e), [`f809189`](https://github.com/Effect-TS/effect/commit/f809189ddf6b6011ba43a9901baaa734e315da2a), [`88a54cc`](https://github.com/Effect-TS/effect/commit/88a54cc341006e3ebcb13482c618f62a680ce199), [`0ebdbe7`](https://github.com/Effect-TS/effect/commit/0ebdbe74463dc84385956d0b1e8c2b79ebab5400), [`7517d09`](https://github.com/Effect-TS/effect/commit/7517d09f12a0b183a81bd425962c4e280a68b05d), [`212493b`](https://github.com/Effect-TS/effect/commit/212493b9a1eb98cd1ef6959c707a2e5784a5ae91), [`88a54cc`](https://github.com/Effect-TS/effect/commit/88a54cc341006e3ebcb13482c618f62a680ce199), [`80ea8cb`](https://github.com/Effect-TS/effect/commit/80ea8cb9222ca73f564c8267ab2f82966fea027a), [`8df19f4`](https://github.com/Effect-TS/effect/commit/8df19f4fe81d90cc33ace88b9a77e5534f82d604)]:
  - effect@4.0.0-beta.99

## 4.0.0-beta.98

### Patch Changes

- Updated dependencies [[`989603b`](https://github.com/Effect-TS/effect-smol/commit/989603b60ab1197b64acf214208e0d370cd1f842), [`214c458`](https://github.com/Effect-TS/effect-smol/commit/214c458084bb6995d543cd37d1055f24be3d454e), [`a037273`](https://github.com/Effect-TS/effect-smol/commit/a0372736ac34796969b051bbba4717d7983f1ebe), [`97fdaa9`](https://github.com/Effect-TS/effect-smol/commit/97fdaa9c1f522c65e579365d314a07878e2b904f), [`b24d248`](https://github.com/Effect-TS/effect-smol/commit/b24d248c8df44222ce642087cde2bd859a2dc709), [`19c222c`](https://github.com/Effect-TS/effect-smol/commit/19c222cac2353a3d7b7733caecb00556fffe9a5c), [`eec85dd`](https://github.com/Effect-TS/effect-smol/commit/eec85ddba09ea326fd268ee33eeffd47e50d4671), [`0082f4f`](https://github.com/Effect-TS/effect-smol/commit/0082f4f74fb139fd578f87f0a790e845133983dc), [`8849052`](https://github.com/Effect-TS/effect-smol/commit/884905232d1e9a365e046d8dde27bf9c5707f57f), [`c15e16a`](https://github.com/Effect-TS/effect-smol/commit/c15e16ad130d1fbde25d912b7ac55995066cb35b), [`01d00a3`](https://github.com/Effect-TS/effect-smol/commit/01d00a3abfbf1f37996cdbe738ea5137c646cdd7), [`8bd4589`](https://github.com/Effect-TS/effect-smol/commit/8bd458975a1b3a8ed042eccf317b93d28ded91e7), [`0082f4f`](https://github.com/Effect-TS/effect-smol/commit/0082f4f74fb139fd578f87f0a790e845133983dc), [`6e08428`](https://github.com/Effect-TS/effect-smol/commit/6e08428d980501b856f846ad3f3f0e4ea46e7786), [`388dcf9`](https://github.com/Effect-TS/effect-smol/commit/388dcf953f65d317547f34d40e6443c5f264205f), [`2b7ce2b`](https://github.com/Effect-TS/effect-smol/commit/2b7ce2b513e7ec2a77822f1116dc6ffb6ba93f4e), [`87bea7e`](https://github.com/Effect-TS/effect-smol/commit/87bea7e16259246f3bcdf565446394751abca953), [`ce38dc3`](https://github.com/Effect-TS/effect-smol/commit/ce38dc33bda805a684432cca071f4dc3c6b9a1ba), [`a807cd1`](https://github.com/Effect-TS/effect-smol/commit/a807cd170341deca8a1cfb52c4222585f2431bb9), [`fd8a356`](https://github.com/Effect-TS/effect-smol/commit/fd8a356f06a8c9ce4e7e0a13fc4021c178ed31de), [`c2a5edc`](https://github.com/Effect-TS/effect-smol/commit/c2a5edc3abd31ad5bc123362bc1213e03e4095c3), [`5946da3`](https://github.com/Effect-TS/effect-smol/commit/5946da3804a1be5e752b05b96bd058cdba50a1bf), [`4ae0c5f`](https://github.com/Effect-TS/effect-smol/commit/4ae0c5ffcbe6c56ddfcb05c639112a079483539e), [`5b2a0bc`](https://github.com/Effect-TS/effect-smol/commit/5b2a0bceea3a28a33a58555210c90a415dc74a76), [`72ac585`](https://github.com/Effect-TS/effect-smol/commit/72ac585884befde6af9208da738699a93f1bae79), [`5e8c1b8`](https://github.com/Effect-TS/effect-smol/commit/5e8c1b82bfafa121311f987a49ab75395e3647a7), [`0f9c078`](https://github.com/Effect-TS/effect-smol/commit/0f9c07841b04183f485ee6e6458de73b290b09f5)]:
  - effect@4.0.0-beta.98

## 4.0.0-beta.97

### Patch Changes

- Updated dependencies []:
  - effect@4.0.0-beta.97

## 4.0.0-beta.96

### Patch Changes

- Updated dependencies [[`1503f45`](https://github.com/Effect-TS/effect-smol/commit/1503f45cb5bb2a74f4705252ec505a1f0ade7e62), [`57fe793`](https://github.com/Effect-TS/effect-smol/commit/57fe79316ffbc380b30626a168981fb26ae97459), [`0c2f78f`](https://github.com/Effect-TS/effect-smol/commit/0c2f78f695ec474e1ff5474da183577975e418f5), [`0c2f78f`](https://github.com/Effect-TS/effect-smol/commit/0c2f78f695ec474e1ff5474da183577975e418f5), [`0c2f78f`](https://github.com/Effect-TS/effect-smol/commit/0c2f78f695ec474e1ff5474da183577975e418f5), [`97f29df`](https://github.com/Effect-TS/effect-smol/commit/97f29df457f7ffd07cfb4b379315c12c086af805)]:
  - effect@4.0.0-beta.96

## 4.0.0-beta.95

### Patch Changes

- Updated dependencies [[`a482442`](https://github.com/Effect-TS/effect-smol/commit/a482442abdeb490e9652b854ec3495e4aa7273e7), [`fbefa85`](https://github.com/Effect-TS/effect-smol/commit/fbefa850fab2f0a302c20614496aeaaa2a8b5590), [`0b4a32f`](https://github.com/Effect-TS/effect-smol/commit/0b4a32f4260f0d8500942a133001b0d349328102), [`18a49e1`](https://github.com/Effect-TS/effect-smol/commit/18a49e1786679456258002ff9397faf02f678c2d), [`266cb90`](https://github.com/Effect-TS/effect-smol/commit/266cb90bb2c17aabc40563c32db334f09ba3d74b), [`912f095`](https://github.com/Effect-TS/effect-smol/commit/912f095a34572bbd3cedf6edb27878443e3e4a95), [`a6718f9`](https://github.com/Effect-TS/effect-smol/commit/a6718f9e00a15ca903b0732da46116cbf3d6aca7), [`bef5154`](https://github.com/Effect-TS/effect-smol/commit/bef51540a243aa2f872a00c01d0cd58b7a769baa), [`18e0564`](https://github.com/Effect-TS/effect-smol/commit/18e0564bd0f8ebbdfcaf1e2c21529948e9e4a81d), [`fb50f14`](https://github.com/Effect-TS/effect-smol/commit/fb50f14fc3657c1973785aa5b72ecf0b0d28e0b2)]:
  - effect@4.0.0-beta.95

## 4.0.0-beta.94

### Patch Changes

- Updated dependencies [[`95a0e9b`](https://github.com/Effect-TS/effect-smol/commit/95a0e9bb62797af0e81c9998773405f248f218c5), [`a0a3490`](https://github.com/Effect-TS/effect-smol/commit/a0a3490bbce765f199d8e077aceac504f0462e63), [`f11ce73`](https://github.com/Effect-TS/effect-smol/commit/f11ce73af60823754dc24194f4ffc561b9ea1c2d), [`ff30b6e`](https://github.com/Effect-TS/effect-smol/commit/ff30b6e7c2c63ffc56a4c5818d6d86b01b5ad528), [`1caab3c`](https://github.com/Effect-TS/effect-smol/commit/1caab3cc30f626efbf15e59d74f539a487e5c85c), [`aa80c47`](https://github.com/Effect-TS/effect-smol/commit/aa80c4775a04db87553e5568764cab7e32a72814), [`c2ae4fc`](https://github.com/Effect-TS/effect-smol/commit/c2ae4fce2f03a4cd1861c2b1179da7df656e662d), [`a0a3490`](https://github.com/Effect-TS/effect-smol/commit/a0a3490bbce765f199d8e077aceac504f0462e63)]:
  - effect@4.0.0-beta.94

## 4.0.0-beta.93

### Patch Changes

- Updated dependencies [[`00652fe`](https://github.com/Effect-TS/effect-smol/commit/00652fe95c18f87208e91343eb8bf218faa2f677), [`6c58167`](https://github.com/Effect-TS/effect-smol/commit/6c5816746eaf91d2a3c7c899c5720809fa230ae3), [`2bc5415`](https://github.com/Effect-TS/effect-smol/commit/2bc541501a7ef89e542d7cb98e96beb53cd205cc), [`e11cccc`](https://github.com/Effect-TS/effect-smol/commit/e11cccc7d5fe631abccc7d6e3bd296938de0fa2e), [`ba7e77e`](https://github.com/Effect-TS/effect-smol/commit/ba7e77e046b8641a3a4e9750bb88ca4a1d063d3f), [`5713ee7`](https://github.com/Effect-TS/effect-smol/commit/5713ee7edbc3054efde407b2286bbfd45bbc6e1c)]:
  - effect@4.0.0-beta.93

## 4.0.0-beta.92

### Patch Changes

- Updated dependencies [[`affdc13`](https://github.com/Effect-TS/effect-smol/commit/affdc139045cc325dce321a84a580fdc1b2da7b9)]:
  - effect@4.0.0-beta.92

## 4.0.0-beta.91

### Patch Changes

- Updated dependencies [[`b135b25`](https://github.com/Effect-TS/effect-smol/commit/b135b2517fca9e7839734ace3699a7dfa75b9075), [`aaa21a3`](https://github.com/Effect-TS/effect-smol/commit/aaa21a369a171c600db294f2a4f640583043e150), [`3475ee6`](https://github.com/Effect-TS/effect-smol/commit/3475ee6c2bda6b05c6d7a12ce30c8bb840b5b1a6)]:
  - effect@4.0.0-beta.91

## 4.0.0-beta.90

### Patch Changes

- Updated dependencies [[`d237fdf`](https://github.com/Effect-TS/effect-smol/commit/d237fdf726481f76eb52a6196e111b24122bc3d5)]:
  - effect@4.0.0-beta.90

## 4.0.0-beta.89

### Patch Changes

- Updated dependencies [[`b7d46ab`](https://github.com/Effect-TS/effect-smol/commit/b7d46ab7e1a29d8711817bab583c9febf48a0dad), [`7777e15`](https://github.com/Effect-TS/effect-smol/commit/7777e1540fd3680dd8346723cffec812b9384669), [`5376197`](https://github.com/Effect-TS/effect-smol/commit/5376197ca8e50358a41b1fd3cec27bd1ec680ec6)]:
  - effect@4.0.0-beta.89

## 4.0.0-beta.88

### Patch Changes

- Updated dependencies [[`911f1b8`](https://github.com/Effect-TS/effect-smol/commit/911f1b84790ce42b3a70c95b33e6f6fd9e74de8b), [`8beeeea`](https://github.com/Effect-TS/effect-smol/commit/8beeeea52879d8613a39468848f01c3092bd54d4), [`c306fcf`](https://github.com/Effect-TS/effect-smol/commit/c306fcfeb1ef38455156932a1faf49292b1318da)]:
  - effect@4.0.0-beta.88

## 4.0.0-beta.87

### Patch Changes

- Updated dependencies [[`5a0c1a4`](https://github.com/Effect-TS/effect-smol/commit/5a0c1a4faee5707b5cc35e646ff1ffdad70f1956), [`1eea2ea`](https://github.com/Effect-TS/effect-smol/commit/1eea2ea3795ba47316b82b1ac8d4612c0ba389ed)]:
  - effect@4.0.0-beta.87

## 4.0.0-beta.86

### Patch Changes

- Updated dependencies [[`0b5795a`](https://github.com/Effect-TS/effect-smol/commit/0b5795a0ab4395e8f15955d8d96f2303084bfc64), [`3e3a859`](https://github.com/Effect-TS/effect-smol/commit/3e3a859ec6351a9e0d31674aabbd48fcefabb12e), [`7dbec24`](https://github.com/Effect-TS/effect-smol/commit/7dbec240dbf3bca599a20c486632abce694ef5ab), [`d8c00a1`](https://github.com/Effect-TS/effect-smol/commit/d8c00a171ac7141e8adc08c332d1162d9a9d56fc), [`85b6317`](https://github.com/Effect-TS/effect-smol/commit/85b631701e935866f2762bd595237aa718370cd9), [`6d0fda0`](https://github.com/Effect-TS/effect-smol/commit/6d0fda0d0cbdfffc523c89c57dfdb1608f84fb12), [`108a933`](https://github.com/Effect-TS/effect-smol/commit/108a9335ff8571928197e5847a09c28ac83d6f46), [`7e1f455`](https://github.com/Effect-TS/effect-smol/commit/7e1f455fab5005d769b939c91e519d450f802cf9), [`46b3e79`](https://github.com/Effect-TS/effect-smol/commit/46b3e79944cfdae7901eb148135c85b7eb39834e)]:
  - effect@4.0.0-beta.86

## 4.0.0-beta.85

### Patch Changes

- Updated dependencies [[`328d97c`](https://github.com/Effect-TS/effect-smol/commit/328d97cc53c0dcb89077a5623e35b095eaa59a8c), [`8441836`](https://github.com/Effect-TS/effect-smol/commit/8441836e6dde70e8ae2126be9cefe9b45798b134), [`074e436`](https://github.com/Effect-TS/effect-smol/commit/074e4361091289104cb0ab6959dc3b0ea7794a6a), [`c1dfd60`](https://github.com/Effect-TS/effect-smol/commit/c1dfd60663eb13a58916f3712d877499943b628a), [`2ba316b`](https://github.com/Effect-TS/effect-smol/commit/2ba316bd15fcbf1c50626500d44a2c9b3bec19f5), [`7ce7344`](https://github.com/Effect-TS/effect-smol/commit/7ce7344c41056c79e2ee19ee6a9346c0f1d227c1)]:
  - effect@4.0.0-beta.85

## 4.0.0-beta.84

### Patch Changes

- Updated dependencies [[`87f52ba`](https://github.com/Effect-TS/effect-smol/commit/87f52ba16c4370ffa3f84bf8e53038e1419c284e), [`b8ee07f`](https://github.com/Effect-TS/effect-smol/commit/b8ee07ffda8903b5ec2e45a786ddcba59f128fda), [`867c0d7`](https://github.com/Effect-TS/effect-smol/commit/867c0d70a09079b040260d45a1e92ff04dbfbf2f), [`b93bc6c`](https://github.com/Effect-TS/effect-smol/commit/b93bc6c9cb27b909a41d094c97c4f9d25bbc6d6b), [`57d387f`](https://github.com/Effect-TS/effect-smol/commit/57d387f92c30ab63e15e3e641f0a903b65886610), [`bacca41`](https://github.com/Effect-TS/effect-smol/commit/bacca4141c2400effae1eabfdb36c89a459cf246), [`0f8ac79`](https://github.com/Effect-TS/effect-smol/commit/0f8ac7959d29ed68c68ce25aabd6bf0cb7e63ecc), [`25b4482`](https://github.com/Effect-TS/effect-smol/commit/25b448270c01317703f25107e1480d4cd0246d9a), [`9cf3a25`](https://github.com/Effect-TS/effect-smol/commit/9cf3a25c66b0c44a52be9829870c44517ea52db2), [`8def767`](https://github.com/Effect-TS/effect-smol/commit/8def7674b1787f91035298cda4d122937e87ef72)]:
  - effect@4.0.0-beta.84

## 4.0.0-beta.83

### Patch Changes

- Updated dependencies [[`1f2e8ce`](https://github.com/Effect-TS/effect-smol/commit/1f2e8ceef09e0a791c850ed2ade01f97089596f9)]:
  - effect@4.0.0-beta.83

## 4.0.0-beta.82

### Patch Changes

- Updated dependencies [[`193690b`](https://github.com/Effect-TS/effect-smol/commit/193690b642ea802bbed40d663bd677251bbe9dc3)]:
  - effect@4.0.0-beta.82

## 4.0.0-beta.81

### Patch Changes

- Updated dependencies [[`93cb4f8`](https://github.com/Effect-TS/effect-smol/commit/93cb4f8fbfb9e07cb9dc86ce6b155fd1f8167914), [`60341d9`](https://github.com/Effect-TS/effect-smol/commit/60341d9ca744d0473ce3fab621ca9bd225af3a39), [`1105ab5`](https://github.com/Effect-TS/effect-smol/commit/1105ab56cb724212f7ea7b431396ce82e8fd0484), [`4500fbf`](https://github.com/Effect-TS/effect-smol/commit/4500fbfe00763d8a72af6e5d6c5988e8bd4ade36)]:
  - effect@4.0.0-beta.81

## 4.0.0-beta.80

### Patch Changes

- Updated dependencies [[`d944330`](https://github.com/Effect-TS/effect-smol/commit/d94433090ee03f426d43e13b883abae4494e55e6), [`f48659f`](https://github.com/Effect-TS/effect-smol/commit/f48659fdcc84930ebc1e5b45b540c0f973389182), [`7652aaa`](https://github.com/Effect-TS/effect-smol/commit/7652aaa3bdbc39f241fe58b54b9a43b713e22e12), [`98630b7`](https://github.com/Effect-TS/effect-smol/commit/98630b7c8f679c352ba6796636c85688fa009d8d), [`90ae23c`](https://github.com/Effect-TS/effect-smol/commit/90ae23cf07284da5e1bcd9dffa882e85df7e617b)]:
  - effect@4.0.0-beta.80

## 4.0.0-beta.79

### Patch Changes

- Updated dependencies [[`b9704dc`](https://github.com/Effect-TS/effect-smol/commit/b9704dc9de9f1649ad502371014fe869b69a49a3), [`a207113`](https://github.com/Effect-TS/effect-smol/commit/a207113f66837bb54416926718a9a7d66774d079), [`5e9b9e2`](https://github.com/Effect-TS/effect-smol/commit/5e9b9e217b164ebfd4a002dd4380b3b1563200c3), [`7c128ae`](https://github.com/Effect-TS/effect-smol/commit/7c128aef458a1e2d224712e51c483c9badad1d44), [`0ada457`](https://github.com/Effect-TS/effect-smol/commit/0ada457c0513d8d908254ab77ebb7d29d2b523d6), [`d7cc5a2`](https://github.com/Effect-TS/effect-smol/commit/d7cc5a2bede3de10943aa0c6bdb4f26836a91efd), [`aad63be`](https://github.com/Effect-TS/effect-smol/commit/aad63becf65e0a6b076e94f8973be7bbe7fbd46f), [`09809f6`](https://github.com/Effect-TS/effect-smol/commit/09809f60f19ec98232f98b33e33e02ecb7e4fbd6), [`2fddda5`](https://github.com/Effect-TS/effect-smol/commit/2fddda5311929f46b61e503f0ade4fc749e8c77d), [`5f21768`](https://github.com/Effect-TS/effect-smol/commit/5f2176833399757c4500d8875b7f2fba0393de75), [`f27003e`](https://github.com/Effect-TS/effect-smol/commit/f27003e00524ff83f20dd9909f62b2f8795efe03)]:
  - effect@4.0.0-beta.79

## 4.0.0-beta.78

### Patch Changes

- Updated dependencies [[`7836b8e`](https://github.com/Effect-TS/effect-smol/commit/7836b8eb8bb0f3e04cdf554ee070caccf74f00c1), [`35d49a3`](https://github.com/Effect-TS/effect-smol/commit/35d49a3a09bdba6b513de87ddcead9e61a1042ba), [`4093258`](https://github.com/Effect-TS/effect-smol/commit/40932580e65bafab5f23c5f14b520cb411d0b2cd)]:
  - effect@4.0.0-beta.78

## 4.0.0-beta.77

### Patch Changes

- Updated dependencies [[`6e9a5ca`](https://github.com/Effect-TS/effect-smol/commit/6e9a5ca62a61156fd67b2518ad3ab14ac0d25f23), [`302f398`](https://github.com/Effect-TS/effect-smol/commit/302f3984ce206e35d86ddd99d3b72be144850a51)]:
  - effect@4.0.0-beta.77

## 4.0.0-beta.76

### Patch Changes

- Updated dependencies [[`016108a`](https://github.com/Effect-TS/effect-smol/commit/016108a472af7048ddbbfd05f233e67529fafe12), [`95c03d2`](https://github.com/Effect-TS/effect-smol/commit/95c03d2c55930668c215b5a41c23cf7742fead84), [`07299a3`](https://github.com/Effect-TS/effect-smol/commit/07299a33c09fd52faa9810d30835a2622c752386)]:
  - effect@4.0.0-beta.76

## 4.0.0-beta.75

### Patch Changes

- [#2312](https://github.com/Effect-TS/effect-smol/pull/2312) [`ad4b535`](https://github.com/Effect-TS/effect-smol/commit/ad4b535e17f94ce35261829d5a3675f0a7808b4e) Thanks @gcanti! - Validate `Schema.StructWithRest` fixed fields against rest index signatures at the type level so schemas cannot be constructed with incompatible decoded, encoded, or make shapes. This keeps `StructWithRest` types sound and updates the generated OpenAI conversation-items request schema to keep accepting arbitrary additional fields under the stricter validation.

- Updated dependencies [[`81b187c`](https://github.com/Effect-TS/effect-smol/commit/81b187c17a0d8817b58232826939154010ae49d7), [`ad4b535`](https://github.com/Effect-TS/effect-smol/commit/ad4b535e17f94ce35261829d5a3675f0a7808b4e), [`a29c2e7`](https://github.com/Effect-TS/effect-smol/commit/a29c2e7e3570920156702671d6f3367cd0195f6c), [`1fdd9ae`](https://github.com/Effect-TS/effect-smol/commit/1fdd9aeed92b6bb70987c862e7f6f66ead0339b3), [`1fdd9ae`](https://github.com/Effect-TS/effect-smol/commit/1fdd9aeed92b6bb70987c862e7f6f66ead0339b3), [`ffea4ec`](https://github.com/Effect-TS/effect-smol/commit/ffea4ecf2925f6a4c9fd13079d47584cbf2bed00), [`4255c9b`](https://github.com/Effect-TS/effect-smol/commit/4255c9ba78bb98c7838fbe9dccdd8465e9da5427)]:
  - effect@4.0.0-beta.75

## 4.0.0-beta.74

### Patch Changes

- Updated dependencies [[`b1fc6a4`](https://github.com/Effect-TS/effect-smol/commit/b1fc6a4b4d0ca7fa9fd162799ae17c86f2f7ee8e)]:
  - effect@4.0.0-beta.74

## 4.0.0-beta.73

### Patch Changes

- Updated dependencies [[`361ca30`](https://github.com/Effect-TS/effect-smol/commit/361ca30eb6e134feece547d6e00f82be4cb23f75), [`b9598c6`](https://github.com/Effect-TS/effect-smol/commit/b9598c6a209e75bfdb87ee3b024ecd1e3923ff6e)]:
  - effect@4.0.0-beta.73

## 4.0.0-beta.72

### Patch Changes

- [#2280](https://github.com/Effect-TS/effect-smol/pull/2280) [`fa07f9e`](https://github.com/Effect-TS/effect-smol/commit/fa07f9e7138bde3e9404aa91c22b41e273aba091) Thanks @tim-smart! - improve openai websocket error status

- Updated dependencies [[`73e67d1`](https://github.com/Effect-TS/effect-smol/commit/73e67d119a84d697773eaecb4865c6a71eb1a9cb), [`01d71ec`](https://github.com/Effect-TS/effect-smol/commit/01d71ec5a75f3c2747a8d3b1ad9701d1e27b7ce5), [`fcd707e`](https://github.com/Effect-TS/effect-smol/commit/fcd707e091a16e1b35343c901cc4052274e32239)]:
  - effect@4.0.0-beta.72

## 4.0.0-beta.71

### Patch Changes

- [#2279](https://github.com/Effect-TS/effect-smol/pull/2279) [`1fab4ac`](https://github.com/Effect-TS/effect-smol/commit/1fab4acc63818dece3a0e732b1a71843f0759f21) Thanks @tim-smart! - handle missing output array in openai responses

- Updated dependencies [[`d8ac76b`](https://github.com/Effect-TS/effect-smol/commit/d8ac76b5bad458c42cebe8a0c1b3843f955ac293), [`2c3c00a`](https://github.com/Effect-TS/effect-smol/commit/2c3c00af6faba7b7d422af26a7a2bbc35636d230), [`3751e7c`](https://github.com/Effect-TS/effect-smol/commit/3751e7cf353e7a54cd692c37401207d9afba1e63), [`fc5f25b`](https://github.com/Effect-TS/effect-smol/commit/fc5f25b03ada5fc2431987768a74d3d3e75ca485), [`7ccced4`](https://github.com/Effect-TS/effect-smol/commit/7ccced42867c14c013b01160b3d292f14c05bd04), [`a2e1fe5`](https://github.com/Effect-TS/effect-smol/commit/a2e1fe5835c98c8ee4393a091b1d11b75126e349), [`4a4a36b`](https://github.com/Effect-TS/effect-smol/commit/4a4a36b10e6e616cad07584a43908f6a7e07e618), [`d350292`](https://github.com/Effect-TS/effect-smol/commit/d3502922b4740fa9d745797cbc3775cb67839b6d), [`730afb6`](https://github.com/Effect-TS/effect-smol/commit/730afb66696adf9bd5a328cbca29df9c05968771), [`df1b008`](https://github.com/Effect-TS/effect-smol/commit/df1b008f370f414c2a67a7b8139ef747af8e5fba), [`6d469d5`](https://github.com/Effect-TS/effect-smol/commit/6d469d567a7c41d7e5343bdee21d45b07b0e8190)]:
  - effect@4.0.0-beta.71

## 4.0.0-beta.70

### Patch Changes

- [#2224](https://github.com/Effect-TS/effect-smol/pull/2224) [`74d8f37`](https://github.com/Effect-TS/effect-smol/commit/74d8f37a05ce755ff09cff48f992cb80ce9e4769) Thanks @aniravi24! - Fix `OpenAIFile` schema decode failure on responses where `expires_at` and `status_details` are returned as literal `null`. The OpenAI files endpoint returns `null` (not omitted) for these fields when no expiration / status detail applies (e.g. uploads with `purpose: "user_data"`), but the upstream OpenAPI spec marks them only as optional. Codegen patches widen both fields to allow `null`, which now decodes cleanly via `OpenAiClient.createFile`, `retrieveFile`, `listFiles`, and any other endpoint returning the `OpenAIFile` shape.

- Updated dependencies [[`af7782d`](https://github.com/Effect-TS/effect-smol/commit/af7782d3008d08b043f3a3f261516001514b2b4e), [`7212d70`](https://github.com/Effect-TS/effect-smol/commit/7212d701a3eee7b3553ff502e2c066126e52e839)]:
  - effect@4.0.0-beta.70

## 4.0.0-beta.69

### Patch Changes

- Updated dependencies [[`70ea04a`](https://github.com/Effect-TS/effect-smol/commit/70ea04aa96a2a7859d738d414e1f0e3ed081a27a), [`d0ea8b0`](https://github.com/Effect-TS/effect-smol/commit/d0ea8b03f7d73ae076c1db12666141e480d11178), [`a57674b`](https://github.com/Effect-TS/effect-smol/commit/a57674b64845e9e75a456cf907bfdcb858859118), [`59aa334`](https://github.com/Effect-TS/effect-smol/commit/59aa334fbd0a504dda3c36f6d2ef1be7449b4b8b), [`8f4208e`](https://github.com/Effect-TS/effect-smol/commit/8f4208ee83bc7bdaa6793b5429847b45aab72470)]:
  - effect@4.0.0-beta.69

## 4.0.0-beta.68

### Patch Changes

- Updated dependencies [[`af8267f`](https://github.com/Effect-TS/effect-smol/commit/af8267f2f3588c3fb611e9286f6f933f29ce1217), [`0176eaf`](https://github.com/Effect-TS/effect-smol/commit/0176eaf3ecd7c1b99a10268f2af02d7e8ce161e5), [`0176eaf`](https://github.com/Effect-TS/effect-smol/commit/0176eaf3ecd7c1b99a10268f2af02d7e8ce161e5), [`f136bb7`](https://github.com/Effect-TS/effect-smol/commit/f136bb763048cbc6b17edd26496dba3e2415b9fa), [`6f38f07`](https://github.com/Effect-TS/effect-smol/commit/6f38f07d5941a211b251383aaab0f4f55e8a6557), [`aec9c40`](https://github.com/Effect-TS/effect-smol/commit/aec9c401a53db227f18bf5e0c84db7130ad862d6)]:
  - effect@4.0.0-beta.68

## 4.0.0-beta.67

### Patch Changes

- Updated dependencies [[`a42ef66`](https://github.com/Effect-TS/effect-smol/commit/a42ef6632abbddfa820995ae310ccc84ae8d9b6f), [`35594f8`](https://github.com/Effect-TS/effect-smol/commit/35594f811cafe471acd490114b103a1f8392c8d8), [`8bddd62`](https://github.com/Effect-TS/effect-smol/commit/8bddd628cb623f9533d345082583ff51cead6836), [`4be4c8d`](https://github.com/Effect-TS/effect-smol/commit/4be4c8d60862aa963869ee2ed9ffa048ffac0527), [`0c9d3ab`](https://github.com/Effect-TS/effect-smol/commit/0c9d3ab43eb721a370ed8306260cbac218c27e87), [`b156acc`](https://github.com/Effect-TS/effect-smol/commit/b156accd2691b4a051f823affdece7c39923ce85), [`d16c034`](https://github.com/Effect-TS/effect-smol/commit/d16c03434ee3e6dcd3bfc82b65d99e881d89025b), [`b559d68`](https://github.com/Effect-TS/effect-smol/commit/b559d68845f848a10153395778f035682d399075), [`a3de5d9`](https://github.com/Effect-TS/effect-smol/commit/a3de5d9215e5cc4a62e2666efbd7c1bf595eb84f), [`7e6c12e`](https://github.com/Effect-TS/effect-smol/commit/7e6c12ec9b3a5945f6c26e272cc8f6390541ad3e), [`098167a`](https://github.com/Effect-TS/effect-smol/commit/098167a220fe07da6f14455818733ab1b269c9dd)]:
  - effect@4.0.0-beta.67

## 4.0.0-beta.66

### Patch Changes

- Updated dependencies [[`ca2498e`](https://github.com/Effect-TS/effect-smol/commit/ca2498e702ac2d83fb7187707b7eb069bdb261a2), [`cd7d1fb`](https://github.com/Effect-TS/effect-smol/commit/cd7d1fba7e2e2c5ac3ad64e1be433440a5bda436), [`19a7033`](https://github.com/Effect-TS/effect-smol/commit/19a703367ec817cffc41d152da9b594827408e2b), [`33d26b4`](https://github.com/Effect-TS/effect-smol/commit/33d26b4210b2e974f146a71e7eed962f8ce00900), [`856766b`](https://github.com/Effect-TS/effect-smol/commit/856766b2c506aaed6d2df1d63bf3a5b1b062e1d4), [`079c7df`](https://github.com/Effect-TS/effect-smol/commit/079c7df82559bb9ce10a86dffb85d25e6ce07dc3)]:
  - effect@4.0.0-beta.66

## 4.0.0-beta.65

### Patch Changes

- Updated dependencies [[`6f11454`](https://github.com/Effect-TS/effect-smol/commit/6f11454a9b6c3bd00f6b35fd7af14a2f2d63a0a2)]:
  - effect@4.0.0-beta.65

## 4.0.0-beta.64

### Patch Changes

- Updated dependencies [[`7d4877a`](https://github.com/Effect-TS/effect-smol/commit/7d4877a1929cdb690280ea254326c04f2ec97ea5)]:
  - effect@4.0.0-beta.64

## 4.0.0-beta.63

### Patch Changes

- [#2133](https://github.com/Effect-TS/effect-smol/pull/2133) [`5be0aaa`](https://github.com/Effect-TS/effect-smol/commit/5be0aaad694c9eb943a710eb4f896bc4c3fcae99) Thanks @Zelys-DFKH! - Fix `OpenAiLanguageModel` leaking library-only config fields (`fileIdPrefixes`, `strictJsonSchema`) into request body, causing OpenAI 400 errors.

- Updated dependencies [[`7f927ff`](https://github.com/Effect-TS/effect-smol/commit/7f927ffb7a9801dcfc4096c29e369d13d65cd0ac), [`a696b3e`](https://github.com/Effect-TS/effect-smol/commit/a696b3e83a8504cdbe261a18c10a1cc0619ae102)]:
  - effect@4.0.0-beta.63

## 4.0.0-beta.62

### Patch Changes

- Updated dependencies [[`4ab4b90`](https://github.com/Effect-TS/effect-smol/commit/4ab4b9007dc27a52ffabc6fcb37c96eeec795bf7)]:
  - effect@4.0.0-beta.62

## 4.0.0-beta.61

### Patch Changes

- Updated dependencies [[`50790af`](https://github.com/Effect-TS/effect-smol/commit/50790af9b190c38d10fb0723837d49b66432638f), [`71f7c3d`](https://github.com/Effect-TS/effect-smol/commit/71f7c3df997deda92c84146d569696dab3bd645c), [`aae8797`](https://github.com/Effect-TS/effect-smol/commit/aae8797b9cb383be0c182dd58d03d787c354238b)]:
  - effect@4.0.0-beta.61

## 4.0.0-beta.60

### Patch Changes

- Updated dependencies [[`f69d567`](https://github.com/Effect-TS/effect-smol/commit/f69d5675dcff9f4137295752baf066b7153fdc09), [`7909c95`](https://github.com/Effect-TS/effect-smol/commit/7909c954b8f6244a35a4b429f8dd0dff45dad620), [`bbb4dcc`](https://github.com/Effect-TS/effect-smol/commit/bbb4dcc6c406b83a416b4ad3541cc02037c420e4), [`7af2207`](https://github.com/Effect-TS/effect-smol/commit/7af2207901eabf3132c1b7010a69b3899c06fbbe), [`848b40a`](https://github.com/Effect-TS/effect-smol/commit/848b40a4bd4bf54a5098617d50c33c88eee8270a)]:
  - effect@4.0.0-beta.60

## 4.0.0-beta.59

### Patch Changes

- [#2101](https://github.com/Effect-TS/effect-smol/pull/2101) [`953edef`](https://github.com/Effect-TS/effect-smol/commit/953edef2e1ade369e530017d64391281ef22f28f) Thanks @tim-smart! - don't omit reasoning from openai config

- Updated dependencies [[`56837ea`](https://github.com/Effect-TS/effect-smol/commit/56837ea2a338395b35550641374e9e589bd8b71d)]:
  - effect@4.0.0-beta.59

## 4.0.0-beta.58

### Patch Changes

- Updated dependencies [[`11993d4`](https://github.com/Effect-TS/effect-smol/commit/11993d4934c66f5dc611b8bbf553f01d501ef8f7), [`96c8b22`](https://github.com/Effect-TS/effect-smol/commit/96c8b22c2057ccddbf10ed269d7697f22119b3ec), [`96c8b22`](https://github.com/Effect-TS/effect-smol/commit/96c8b22c2057ccddbf10ed269d7697f22119b3ec)]:
  - effect@4.0.0-beta.58

## 4.0.0-beta.57

### Patch Changes

- Updated dependencies [[`a971f5c`](https://github.com/Effect-TS/effect-smol/commit/a971f5cbd92dfe4274420bf0966595eb35531060), [`8e110c5`](https://github.com/Effect-TS/effect-smol/commit/8e110c5f02a429ccc43a91df8678e402138c0851)]:
  - effect@4.0.0-beta.57

## 4.0.0-beta.56

### Patch Changes

- [#1933](https://github.com/Effect-TS/effect-smol/pull/1933) [`c5a7327`](https://github.com/Effect-TS/effect-smol/commit/c5a732746690185b8bb7935d0cf26a5ef21658e4) Thanks @IMax153! - Accept both `in-memory` and `in_memory` for OpenAI `prompt_cache_retention` schema fields.

- [#1933](https://github.com/Effect-TS/effect-smol/pull/1933) [`c5a7327`](https://github.com/Effect-TS/effect-smol/commit/c5a732746690185b8bb7935d0cf26a5ef21658e4) Thanks @IMax153! - Fix OpenAI MCP tool call handling to keep the canonical `OpenAiMcp` tool name across response and stream paths, including approval flows.

- Updated dependencies []:
  - effect@4.0.0-beta.56

## 4.0.0-beta.55

### Patch Changes

- Updated dependencies [[`42cc744`](https://github.com/Effect-TS/effect-smol/commit/42cc744570968deb365fb46d47b53d3277050c93), [`04855ce`](https://github.com/Effect-TS/effect-smol/commit/04855ceeca4d40c55a5750dd9893b691f8ea741a)]:
  - effect@4.0.0-beta.55

## 4.0.0-beta.54

### Patch Changes

- Updated dependencies [[`e4b74f9`](https://github.com/Effect-TS/effect-smol/commit/e4b74f9c01a0e9b6cd58416de4af3a26d51da7c8), [`4c72808`](https://github.com/Effect-TS/effect-smol/commit/4c728081851c66dacf889a816535671bc841ae96)]:
  - effect@4.0.0-beta.54

## 4.0.0-beta.53

### Patch Changes

- [#2060](https://github.com/Effect-TS/effect-smol/pull/2060) [`aef2b1c`](https://github.com/Effect-TS/effect-smol/commit/aef2b1c0130a61a430f116465e4c200c51bcd9e2) Thanks @tim-smart! - add back openai reasoning types

- Updated dependencies [[`0768509`](https://github.com/Effect-TS/effect-smol/commit/07685094e931af07d104165195826a535b55fa7e), [`476aede`](https://github.com/Effect-TS/effect-smol/commit/476aede69c6efa06b5781ca5eb3e3b128ca29141), [`4f79c54`](https://github.com/Effect-TS/effect-smol/commit/4f79c542e7b508c235ff485d862cc8b29a8260c5), [`4be6a7c`](https://github.com/Effect-TS/effect-smol/commit/4be6a7cf35dab2a01d652f56dd35f0358c5a7e88), [`88927eb`](https://github.com/Effect-TS/effect-smol/commit/88927ebb896162cdba103b36553280b58e0facac)]:
  - effect@4.0.0-beta.53

## 4.0.0-beta.52

### Minor Changes

- [#2059](https://github.com/Effect-TS/effect-smol/pull/2059) [`6f73f92`](https://github.com/Effect-TS/effect-smol/commit/6f73f92291733dc1e970e222e63aba865183a072) Thanks @tim-smart! - Add a new public `OpenAiSchema` module with minimal local schemas for responses, streaming SSE events (including unknown-event fallback), and embeddings.

### Patch Changes

- [#2059](https://github.com/Effect-TS/effect-smol/pull/2059) [`6f73f92`](https://github.com/Effect-TS/effect-smol/commit/6f73f92291733dc1e970e222e63aba865183a072) Thanks @tim-smart! - Add a new `OpenAiClientGenerated` module that exposes the generated OpenAI client as a dedicated context service with `make`, `layer`, and `layerConfig` constructors. This provides a compatibility path for direct generated-client access while preserving existing auth, base URL, header, and `OpenAiConfig.transformClient` wiring.

- [#2059](https://github.com/Effect-TS/effect-smol/pull/2059) [`6f73f92`](https://github.com/Effect-TS/effect-smol/commit/6f73f92291733dc1e970e222e63aba865183a072) Thanks @tim-smart! - Refactor `OpenAiClient` to the handwritten minimal-schema path so `client` now exposes the configured `HttpClient`, `createResponse` / `createResponseStream` / `createEmbedding` use `OpenAiSchema` request-response types, and websocket mode no longer depends on generated-client internals.

  Also migrate OpenAI language and embedding model request-response typing to `OpenAiSchema` and make embedding decoding explicitly reject non-vector (string/base64) payloads with `InvalidOutputError`.

- Updated dependencies [[`8e04bfc`](https://github.com/Effect-TS/effect-smol/commit/8e04bfc95554b74eac205d67a20388e056b21499), [`cf3a311`](https://github.com/Effect-TS/effect-smol/commit/cf3a311d863a8abb818840c3b80f847e621c43c1), [`8e04bfc`](https://github.com/Effect-TS/effect-smol/commit/8e04bfc95554b74eac205d67a20388e056b21499), [`131fdd5`](https://github.com/Effect-TS/effect-smol/commit/131fdd5b1f26531e265fe1a08f002002f47c276e)]:
  - effect@4.0.0-beta.52

## 4.0.0-beta.51

### Patch Changes

- Updated dependencies [[`778d2af`](https://github.com/Effect-TS/effect-smol/commit/778d2afe9b5154bc1f9abae46d93ea7e54c87344), [`4e24dcf`](https://github.com/Effect-TS/effect-smol/commit/4e24dcf75037f65eebc1eb68623bc7cbf9d5512a), [`4b1c015`](https://github.com/Effect-TS/effect-smol/commit/4b1c0150e9bdb5559ed32d250deb66e17b4240c7), [`454f8ad`](https://github.com/Effect-TS/effect-smol/commit/454f8adad822929c3ef60f8280d0987226b049fd), [`6754a0c`](https://github.com/Effect-TS/effect-smol/commit/6754a0cd18626b06805a079cc5265525a5eb7d27), [`90f7fd5`](https://github.com/Effect-TS/effect-smol/commit/90f7fd5243871b30980964135db4512b8119fa82), [`d7e1519`](https://github.com/Effect-TS/effect-smol/commit/d7e151974934201fd93fa4c8a1192ee9a5d965a0), [`72a8122`](https://github.com/Effect-TS/effect-smol/commit/72a81228e09782bae512f7d041bbfbc78bc668d0)]:
  - effect@4.0.0-beta.51

## 4.0.0-beta.50

### Patch Changes

- Updated dependencies [[`07be594`](https://github.com/Effect-TS/effect-smol/commit/07be594825de60f8e1b2102d21dbb9b8fc63b414), [`ae02433`](https://github.com/Effect-TS/effect-smol/commit/ae02433103ce28f53a0c9bfb4a44e75773289b7b)]:
  - effect@4.0.0-beta.50

## 4.0.0-beta.49

### Patch Changes

- Updated dependencies [[`7d87873`](https://github.com/Effect-TS/effect-smol/commit/7d8787340ff549370f6f2a88b612e9ebbfd6ba45), [`c2f6f90`](https://github.com/Effect-TS/effect-smol/commit/c2f6f901b200a6e515b4f02c93ce8005b7bbf1c5), [`216f13c`](https://github.com/Effect-TS/effect-smol/commit/216f13c1fce454a21b489bb915714a17e791a1ac)]:
  - effect@4.0.0-beta.49

## 4.0.0-beta.48

### Patch Changes

- Updated dependencies [[`4da56ec`](https://github.com/Effect-TS/effect-smol/commit/4da56ecff129b2da40137ffede23a73cc4e532d8), [`a5e6f77`](https://github.com/Effect-TS/effect-smol/commit/a5e6f774bab195cf50ecdc818240765f69a3bf4a), [`f1ba5b8`](https://github.com/Effect-TS/effect-smol/commit/f1ba5b8584d325a541156928cecf041b37fd5070), [`f1ba5b8`](https://github.com/Effect-TS/effect-smol/commit/f1ba5b8584d325a541156928cecf041b37fd5070)]:
  - effect@4.0.0-beta.48

## 4.0.0-beta.47

### Patch Changes

- Updated dependencies [[`c584726`](https://github.com/Effect-TS/effect-smol/commit/c58472674e750e6938df955044eab88feda95e45), [`86a91a4`](https://github.com/Effect-TS/effect-smol/commit/86a91a4f0c59286dfa9393232d8020dea70ed4db), [`131caf9`](https://github.com/Effect-TS/effect-smol/commit/131caf9525151a0cb29803a8f1dffa0f4f479d12), [`c3615c8`](https://github.com/Effect-TS/effect-smol/commit/c3615c88379b9daf252df0db72c6ac5a20326406)]:
  - effect@4.0.0-beta.47

## 4.0.0-beta.46

### Patch Changes

- Updated dependencies [[`3a30b9e`](https://github.com/Effect-TS/effect-smol/commit/3a30b9e2ec2bd8b8193e1aa139f6878a07e3f5ee)]:
  - effect@4.0.0-beta.46

## 4.0.0-beta.45

### Patch Changes

- Updated dependencies [[`5c3af6d`](https://github.com/Effect-TS/effect-smol/commit/5c3af6d554f60be34f8fc21d598d9a298ae11beb)]:
  - effect@4.0.0-beta.45

## 4.0.0-beta.44

### Patch Changes

- [#1961](https://github.com/Effect-TS/effect-smol/pull/1961) [`7bb5dce`](https://github.com/Effect-TS/effect-smol/commit/7bb5dce60e1d904ef049a0287dec2b2e6113c970) Thanks @IMax153! - Rename the `ServiceMap` module to `Context` across exports, docs, and tests.

- Updated dependencies [[`e3f0621`](https://github.com/Effect-TS/effect-smol/commit/e3f0621454c3f5d11070d30619da27c9232cadc1), [`5b476ab`](https://github.com/Effect-TS/effect-smol/commit/5b476abc0bd7e9bb59135ea1bcad2e4936227ced), [`6b40e5a`](https://github.com/Effect-TS/effect-smol/commit/6b40e5a4a6bd2087c15a3d7374d25057fdedfa16), [`7bb5dce`](https://github.com/Effect-TS/effect-smol/commit/7bb5dce60e1d904ef049a0287dec2b2e6113c970), [`3b09fb3`](https://github.com/Effect-TS/effect-smol/commit/3b09fb31c40c2802b01f21c23bcdd1fe7fb0aa82), [`2370410`](https://github.com/Effect-TS/effect-smol/commit/237041062e5af4594d32db91597e34e70a632877), [`dabc272`](https://github.com/Effect-TS/effect-smol/commit/dabc272444a700eb629c07ba3e77671a841ca86e), [`08b63c3`](https://github.com/Effect-TS/effect-smol/commit/08b63c3df11bd35c9fd6090dbd166287fdc40664), [`dfff04c`](https://github.com/Effect-TS/effect-smol/commit/dfff04c4c2b1d352dfad83992a6dce1280c85cf9), [`9baed9e`](https://github.com/Effect-TS/effect-smol/commit/9baed9e17e84702e6e480fcef6f86404f9e24be9), [`7846792`](https://github.com/Effect-TS/effect-smol/commit/7846792adc7e1631d62d26d657bd7ba6139f369b), [`1556a24`](https://github.com/Effect-TS/effect-smol/commit/1556a247623636b7ebe438fb56d77f1a7bf957bb), [`7c11bc2`](https://github.com/Effect-TS/effect-smol/commit/7c11bc292ab8e46252fe8f7576fb685917bfb8b5), [`b5ea591`](https://github.com/Effect-TS/effect-smol/commit/b5ea5913ec1d45d0dd12a327b9dd966bda2f6d02), [`0853afa`](https://github.com/Effect-TS/effect-smol/commit/0853afaeb1633b2d7f8b66893bd01c3aa1ef2c22), [`ac845f3`](https://github.com/Effect-TS/effect-smol/commit/ac845f3ab40e0b8719576e7f9bc16ea2e0e02cd4), [`b80c462`](https://github.com/Effect-TS/effect-smol/commit/b80c46247480f47bb64fc480fab48a3f37bc8888), [`b3f535d`](https://github.com/Effect-TS/effect-smol/commit/b3f535d9a7ac13b5fb984c29f93561c57a081ff0), [`6fe2e93`](https://github.com/Effect-TS/effect-smol/commit/6fe2e93cc2f1b173ef89651d74b6a5d2626b3226), [`cda8004`](https://github.com/Effect-TS/effect-smol/commit/cda800451c1ffbdddfc08415aed7b2d91e0412ee), [`8335477`](https://github.com/Effect-TS/effect-smol/commit/8335477a8a936a24b5f3ee6203c1b268bd1bfc3c), [`8c836f9`](https://github.com/Effect-TS/effect-smol/commit/8c836f99ab1e896b9580a71d67773625baff2eaf), [`718ff6f`](https://github.com/Effect-TS/effect-smol/commit/718ff6fe3e3d3820cefd67d2bff1b2224fe08060), [`7eed84f`](https://github.com/Effect-TS/effect-smol/commit/7eed84fc33c5781a6fb11bf4fd189d424902ebd4), [`5df46fe`](https://github.com/Effect-TS/effect-smol/commit/5df46fe2f654d59ab5fc1578f4fc27fa40368ef9), [`82dd0f2`](https://github.com/Effect-TS/effect-smol/commit/82dd0f26c6442b07143762ef7bc33742d3978dd6), [`03ae41e`](https://github.com/Effect-TS/effect-smol/commit/03ae41e7304cffac9f18feea22b73468feafc43a), [`4677a0a`](https://github.com/Effect-TS/effect-smol/commit/4677a0a58f95eea38a211efcd3f345f237a9e44a), [`87e1fc8`](https://github.com/Effect-TS/effect-smol/commit/87e1fc8b67e4901d75f567b2fecc3841ab762cc4), [`c1af1b7`](https://github.com/Effect-TS/effect-smol/commit/c1af1b756f63291e9c0298cf95c98a6920a0c2a0), [`7bb5dce`](https://github.com/Effect-TS/effect-smol/commit/7bb5dce60e1d904ef049a0287dec2b2e6113c970), [`c8a877b`](https://github.com/Effect-TS/effect-smol/commit/c8a877b53e8f29616335719e5dd1c3992dddf780), [`7da961a`](https://github.com/Effect-TS/effect-smol/commit/7da961ae4916229d2246699a5d3b20e5b2dd2020)]:
  - effect@4.0.0-beta.44

## 4.0.0-beta.43

### Patch Changes

- [#1905](https://github.com/Effect-TS/effect-smol/pull/1905) [`fc1444d`](https://github.com/Effect-TS/effect-smol/commit/fc1444df6fb7223ed228650c5c927b1df54a8757) Thanks @tim-smart! - openai ws tweaks

- Updated dependencies [[`2ae33d0`](https://github.com/Effect-TS/effect-smol/commit/2ae33d050914915f7cb9c25ab0a020901e08d596), [`979811a`](https://github.com/Effect-TS/effect-smol/commit/979811a4c3f7ed21ed18ef560c49fb7f5569e80e), [`eb7dbef`](https://github.com/Effect-TS/effect-smol/commit/eb7dbeffa883386ad912815e62c0820cac1fdf8e), [`cf50eb4`](https://github.com/Effect-TS/effect-smol/commit/cf50eb49cb04706dae5185f624708117c413dee8), [`1d046fe`](https://github.com/Effect-TS/effect-smol/commit/1d046fe484560e23f3e22cb23eec6433f8f1fa02)]:
  - effect@4.0.0-beta.43

## 4.0.0-beta.42

### Patch Changes

- [#1859](https://github.com/Effect-TS/effect-smol/pull/1859) [`a4809db`](https://github.com/Effect-TS/effect-smol/commit/a4809db80f65601d37ccafc13d773e55909c4e98) Thanks @lloydrichards! - add dynamic tooling for openai and openai-compact language models

- [#1890](https://github.com/Effect-TS/effect-smol/pull/1890) [`4549175`](https://github.com/Effect-TS/effect-smol/commit/454917547e8c305707f0777f4efac7adaa924f00) Thanks @tim-smart! - reset openai websocket on error

- Updated dependencies [[`924e216`](https://github.com/Effect-TS/effect-smol/commit/924e216caa7e0bbf22e994a0cd2ce8b1f0f0b3ee), [`80e7f0c`](https://github.com/Effect-TS/effect-smol/commit/80e7f0cd9116e811e97b0ce30a77a8d1ecd072aa), [`f8328bf`](https://github.com/Effect-TS/effect-smol/commit/f8328bf0314da3dc7f31d314f94a5840e8d5217f), [`66d1c06`](https://github.com/Effect-TS/effect-smol/commit/66d1c06039079129707a230f7ad8c676439d7133), [`bee800b`](https://github.com/Effect-TS/effect-smol/commit/bee800bf285192a01bec72a7b7b51bc1159434e6), [`8930441`](https://github.com/Effect-TS/effect-smol/commit/8930441dee6f94c59c583d18d3ebd677cf1f2623)]:
  - effect@4.0.0-beta.42

## 4.0.0-beta.41

### Patch Changes

- [#1887](https://github.com/Effect-TS/effect-smol/pull/1887) [`f291344`](https://github.com/Effect-TS/effect-smol/commit/f2913443d99146a6b36d8437e50b94f7c03c1284) Thanks @tim-smart! - make defects a retryable network error in websocket mode

- Updated dependencies [[`36f5c21`](https://github.com/Effect-TS/effect-smol/commit/36f5c2174d31ab42c4598bf81f178f40d0802283), [`d8ce758`](https://github.com/Effect-TS/effect-smol/commit/d8ce758669d6297ae932ac3251d83e7b49b22f30), [`11aab4c`](https://github.com/Effect-TS/effect-smol/commit/11aab4c6d37d5691adafc2d33da1a631b28ce814), [`3bc1efb`](https://github.com/Effect-TS/effect-smol/commit/3bc1efb53dd75b4a40de46f1f80c7f8a7d50af86), [`70e724e`](https://github.com/Effect-TS/effect-smol/commit/70e724e604604d4be1061cd8da0d360494998c84), [`738dee7`](https://github.com/Effect-TS/effect-smol/commit/738dee7edfd70af82dc4d2376db3a8ebe603eb48), [`2111963`](https://github.com/Effect-TS/effect-smol/commit/2111963f19b4c28c800664a8fac9590c1321885f), [`198a553`](https://github.com/Effect-TS/effect-smol/commit/198a553d9ce45f6a00bfc4d65ed0640669602d95)]:
  - effect@4.0.0-beta.41

## 4.0.0-beta.40

### Patch Changes

- Updated dependencies [[`f62860f`](https://github.com/Effect-TS/effect-smol/commit/f62860f0e5e45978fabf7256ae620a13152a772a), [`973f281`](https://github.com/Effect-TS/effect-smol/commit/973f2812529aadc1cc54598b2039799fa72b80f8)]:
  - effect@4.0.0-beta.40

## 4.0.0-beta.39

### Patch Changes

- Updated dependencies [[`f91fd3d`](https://github.com/Effect-TS/effect-smol/commit/f91fd3db39fe5628439fd175fba201a65a1aa9d0), [`edaae9d`](https://github.com/Effect-TS/effect-smol/commit/edaae9d65f464f941d7eddd723cd33d324f4b071), [`b47db0b`](https://github.com/Effect-TS/effect-smol/commit/b47db0bd5802064b6a24b3ea27c6ff2e0520d513), [`82d3c8e`](https://github.com/Effect-TS/effect-smol/commit/82d3c8e4f3f49b00df611b25aa6f8f74ec21b59b), [`7c22b31`](https://github.com/Effect-TS/effect-smol/commit/7c22b315d198dcbf44ae8cdb8b37879e1c9e3996)]:
  - effect@4.0.0-beta.39

## 4.0.0-beta.38

### Patch Changes

- Updated dependencies [[`f4dbe5b`](https://github.com/Effect-TS/effect-smol/commit/f4dbe5b26b9c2d33fae024bf44afbdf8541792cd), [`a71a607`](https://github.com/Effect-TS/effect-smol/commit/a71a607c89fb6669a12a562c2c23be81dfbe1adb), [`66a0494`](https://github.com/Effect-TS/effect-smol/commit/66a0494ed75cd12f2721dcbb1d8a072e3d9e14b6), [`5ef7218`](https://github.com/Effect-TS/effect-smol/commit/5ef7218fc559d57301fe929b8a0cab4033f4f1fd), [`472d260`](https://github.com/Effect-TS/effect-smol/commit/472d260655bc311fba5c2c6e23bb77d8f7e36ba0)]:
  - effect@4.0.0-beta.38

## 4.0.0-beta.37

### Patch Changes

- Updated dependencies [[`f7a0b71`](https://github.com/Effect-TS/effect-smol/commit/f7a0b711da8fdd645597dee29cacc5619c6afcf2), [`1e223c3`](https://github.com/Effect-TS/effect-smol/commit/1e223c30ccf835dfbb21284535d78549efaeca80), [`53740f4`](https://github.com/Effect-TS/effect-smol/commit/53740f47aa76d114b7d535649fb50efc54a09608), [`8c7cf89`](https://github.com/Effect-TS/effect-smol/commit/8c7cf89f719e580cbce1bf6c24e6996f1992a0a6), [`b6b81a9`](https://github.com/Effect-TS/effect-smol/commit/b6b81a940eaafcbc792d25413d6c02c707de31b2), [`8f4c1f9`](https://github.com/Effect-TS/effect-smol/commit/8f4c1f97ed60f8810b0b327b50117ffb2d8260d4), [`f2479f9`](https://github.com/Effect-TS/effect-smol/commit/f2479f9d3113b1f012db17a3852b4e28f478cf9c), [`c919921`](https://github.com/Effect-TS/effect-smol/commit/c9199217fad65529421d2cf95ecfff41257090fd), [`7af90c2`](https://github.com/Effect-TS/effect-smol/commit/7af90c2e3c99038eafa39650433839523790e2fe), [`f3be185`](https://github.com/Effect-TS/effect-smol/commit/f3be18569e5ca57c25eabf00df3ca601ebab43c7)]:
  - effect@4.0.0-beta.37

## 4.0.0-beta.36

### Patch Changes

- [#1807](https://github.com/Effect-TS/effect-smol/pull/1807) [`1bbd4d9`](https://github.com/Effect-TS/effect-smol/commit/1bbd4d9d617e683a7f338ddd40d11f5838c722bd) Thanks @tim-smart! - Handle streamed OpenAI function calls from `response.function_call_arguments.done` so tool calls are emitted even when `response.output_item.done` is missing.

- [#1809](https://github.com/Effect-TS/effect-smol/pull/1809) [`126db2e`](https://github.com/Effect-TS/effect-smol/commit/126db2e38774c8ef4934321a70d39428ed4491ed) Thanks @tim-smart! - Fix OpenAI reasoning stream state handling so out-of-order reasoning summary events do not crash when prior reasoning item state is missing.

- Updated dependencies [[`60fcbcc`](https://github.com/Effect-TS/effect-smol/commit/60fcbcc43d09471e8f7e0969955d99dcefc5be81), [`0a60837`](https://github.com/Effect-TS/effect-smol/commit/0a6083713124440e630030375bab367e8d7df24e), [`49164d2`](https://github.com/Effect-TS/effect-smol/commit/49164d2c20a8d21b66514992c4a15d8521f6b36e), [`334b6e4`](https://github.com/Effect-TS/effect-smol/commit/334b6e4f76fe11941b516d61f57e268bc31f0ca6), [`5700695`](https://github.com/Effect-TS/effect-smol/commit/5700695f76ae6da6b94c9c87d4dd2b8054fb829b), [`f8f4456`](https://github.com/Effect-TS/effect-smol/commit/f8f445644f3aa7ec093cab7445198a62ba18a480), [`969d24f`](https://github.com/Effect-TS/effect-smol/commit/969d24fdfa48c4838e811983848d9cb4e9b3b12c), [`851eda0`](https://github.com/Effect-TS/effect-smol/commit/851eda0533946e39bacaaf581896320d7a4f3e8c), [`8059c1c`](https://github.com/Effect-TS/effect-smol/commit/8059c1c3eba9a90af7cd889ea261bcb8fff0c185), [`6f83295`](https://github.com/Effect-TS/effect-smol/commit/6f8329546a73eaddc7cb5e85ea8e37e73fbfb611), [`65f7f57`](https://github.com/Effect-TS/effect-smol/commit/65f7f5737575fed668987462c96d29a446707c32), [`e7fabd2`](https://github.com/Effect-TS/effect-smol/commit/e7fabd2265db690eae5cfc9b83730c84699aef61), [`89c3e98`](https://github.com/Effect-TS/effect-smol/commit/89c3e985401eb38f33a3ae21a94ad27de3c1d28b), [`53794ab`](https://github.com/Effect-TS/effect-smol/commit/53794ab7af30aa5c5004ecf53659fafbe4b10542)]:
  - effect@4.0.0-beta.36

## 4.0.0-beta.35

### Patch Changes

- [#1776](https://github.com/Effect-TS/effect-smol/pull/1776) [`f5e553d`](https://github.com/Effect-TS/effect-smol/commit/f5e553d133b8e0a303f6c82624d2fec4ab8043da) Thanks @tim-smart! - improve openai socket errors

- Updated dependencies [[`9252b43`](https://github.com/Effect-TS/effect-smol/commit/9252b43560f507709c2985abcf52a7837b23ddf8), [`7daf387`](https://github.com/Effect-TS/effect-smol/commit/7daf3870a656882a488a60f67881e6808c8f4d04), [`e1664a3`](https://github.com/Effect-TS/effect-smol/commit/e1664a38bc31ef4ceb4e9324c7226e1e99bf9c07), [`fdaa6e0`](https://github.com/Effect-TS/effect-smol/commit/fdaa6e0a41b6b6605438fa8557441792135380a2), [`19aa47e`](https://github.com/Effect-TS/effect-smol/commit/19aa47ef7b470e427620edca8970dd9cdd551216), [`c667dad`](https://github.com/Effect-TS/effect-smol/commit/c667dad07777b860e4764a3ba9a6cc41c236cd98), [`764d150`](https://github.com/Effect-TS/effect-smol/commit/764d1501bc5026b60fc8aef6cb02a5a87c762801), [`3c27098`](https://github.com/Effect-TS/effect-smol/commit/3c27098b5685a63db2c2eff654a250c94d3fcfa7)]:
  - effect@4.0.0-beta.35

## 4.0.0-beta.34

### Patch Changes

- [#1759](https://github.com/Effect-TS/effect-smol/pull/1759) [`8feecd2`](https://github.com/Effect-TS/effect-smol/commit/8feecd24158f254ca0571a1ddb554b560ed3177d) Thanks @tim-smart! - Ensure OpenAiSocket sends a `{"type":"response.cancel"}` websocket event when a response stream is interrupted.

- [#1764](https://github.com/Effect-TS/effect-smol/pull/1764) [`342fc4b`](https://github.com/Effect-TS/effect-smol/commit/342fc4b051739e32e7977159f26ff9541eda664f) Thanks @tim-smart! - Add unstable EmbeddingModel support across core and OpenAI providers.
  - Add the unstable EmbeddingModel module API surface in `effect`, including service, request, response, and provider types.
  - Implement the unstable EmbeddingModel runtime constructor in `effect`, with `RequestResolver` batching, `embed` / `embedMany` spans, provider error propagation, deterministic ordering, and empty-input `embedMany` fast-path behavior.
  - Add and align EmbeddingModel behavior tests in `effect` for embedding usage, batching, ordering, and error handling.
  - Add `OpenAiEmbeddingModel` in `@effect/ai-openai`, including model / make / layer constructors, config overrides, and provider output index validation with deterministic reordering.
  - Add OpenAI-compatible EmbeddingModel provider support in `@effect/ai-openai-compat`, including config overrides, layer constructors, and output index validation.

- [#1771](https://github.com/Effect-TS/effect-smol/pull/1771) [`00add69`](https://github.com/Effect-TS/effect-smol/commit/00add69b59551e9df34772eb927638b093f6d71e) Thanks @tim-smart! - Add `EmbeddingModel.ModelDimensions` and require dimensions in embedding provider `model` constructors.

- [#1765](https://github.com/Effect-TS/effect-smol/pull/1765) [`f4e2aba`](https://github.com/Effect-TS/effect-smol/commit/f4e2aba01b76d1e3059b297e3cc942284dfeafb2) Thanks @tim-smart! - retry incremental prompt on invalid request

- [#1760](https://github.com/Effect-TS/effect-smol/pull/1760) [`273f4c6`](https://github.com/Effect-TS/effect-smol/commit/273f4c6517f5adc4994734a46698c52015890d1a) Thanks @tim-smart! - handle openai ws error events

- Updated dependencies [[`f2f75ee`](https://github.com/Effect-TS/effect-smol/commit/f2f75ee564bce1cd95f5189c7bdeeed4f92dacb1), [`342fc4b`](https://github.com/Effect-TS/effect-smol/commit/342fc4b051739e32e7977159f26ff9541eda664f), [`5d704ee`](https://github.com/Effect-TS/effect-smol/commit/5d704ee10d20e8eb107e34bb8a21feb5aa4a7685), [`00add69`](https://github.com/Effect-TS/effect-smol/commit/00add69b59551e9df34772eb927638b093f6d71e), [`58217d3`](https://github.com/Effect-TS/effect-smol/commit/58217d318a7d716ccd707cce0f41573946939c28), [`f4e2aba`](https://github.com/Effect-TS/effect-smol/commit/f4e2aba01b76d1e3059b297e3cc942284dfeafb2), [`e3b44b6`](https://github.com/Effect-TS/effect-smol/commit/e3b44b6a2af9ee21dc5c1e928f0c20af857fa7a9), [`e1472b7`](https://github.com/Effect-TS/effect-smol/commit/e1472b7525c5d57a48bdec2353c3b742f7f916c0), [`7686320`](https://github.com/Effect-TS/effect-smol/commit/7686320cd123fa352b5c3d076fb18a3cac0a9bba)]:
  - effect@4.0.0-beta.34

## 4.0.0-beta.33

### Patch Changes

- [#1638](https://github.com/Effect-TS/effect-smol/pull/1638) [`e198fea`](https://github.com/Effect-TS/effect-smol/commit/e198fea76c89a36c6f05ea7b7d11d222cf5a240c) Thanks @tim-smart! - add OpenAiClient.withWebSocketMode

- Updated dependencies [[`571447d`](https://github.com/Effect-TS/effect-smol/commit/571447da67334449f8ae3d6ecb3d77ea4e0c4295)]:
  - effect@4.0.0-beta.33

## 4.0.0-beta.32

### Patch Changes

- Updated dependencies [[`bf8fff8`](https://github.com/Effect-TS/effect-smol/commit/bf8fff8a5f54b6df74cb7bbb42346fe9ba52435a), [`1af3ef3`](https://github.com/Effect-TS/effect-smol/commit/1af3ef3e3ca7fd417d0fc15f8ca8fe207eba4f74), [`27fea0f`](https://github.com/Effect-TS/effect-smol/commit/27fea0f66910de5905f40fd63f8ddbb6f7ac5aba), [`2ad6c1b`](https://github.com/Effect-TS/effect-smol/commit/2ad6c1b2c85a3a0fe351e3d56636a75eb76b4b4e), [`398ac3e`](https://github.com/Effect-TS/effect-smol/commit/398ac3e01cb75efce0e4e2913d1450cf65866732), [`51fe22f`](https://github.com/Effect-TS/effect-smol/commit/51fe22f3266e417b6c541aaed4b75d246fac91e7), [`4605db6`](https://github.com/Effect-TS/effect-smol/commit/4605db69cfacddbdbf1525865ddfde135158090c), [`f4de1b0`](https://github.com/Effect-TS/effect-smol/commit/f4de1b087c998d0bad1d9468f70b7d16c13b9f6f), [`60214f2`](https://github.com/Effect-TS/effect-smol/commit/60214f2080b2aeb091f691140eb20acb741691c3), [`c4b8b0f`](https://github.com/Effect-TS/effect-smol/commit/c4b8b0ffa8efb47c4cd7578a8943d6868509373f), [`6d9393a`](https://github.com/Effect-TS/effect-smol/commit/6d9393a0770a18722d23340e77f15455de341245), [`6de4efe`](https://github.com/Effect-TS/effect-smol/commit/6de4efe463c783614ceb0c094d77a336a899cbe0), [`4f969d1`](https://github.com/Effect-TS/effect-smol/commit/4f969d1563ba755ffa116c8ae409bb3436bd881d), [`6cc67c8`](https://github.com/Effect-TS/effect-smol/commit/6cc67c855e054ee3f3ac3485dca5f7805e79e8fb), [`8531a22`](https://github.com/Effect-TS/effect-smol/commit/8531a22ffbb52e11a030b09f358cafbfdf5edff7), [`b226760`](https://github.com/Effect-TS/effect-smol/commit/b22676067617f15c00722a3a63fd7c2c172c3d45), [`47a51ab`](https://github.com/Effect-TS/effect-smol/commit/47a51aba0ecdf3ef478bfa28a498bca188399bd4), [`1521d02`](https://github.com/Effect-TS/effect-smol/commit/1521d02e1f19f1d795edaaf862c1a1031d9c755e)]:
  - effect@4.0.0-beta.32

## 4.0.0-beta.31

### Patch Changes

- Updated dependencies [[`5a84853`](https://github.com/Effect-TS/effect-smol/commit/5a8485397b7f321ae021640c1999821143659462), [`6f23f0e`](https://github.com/Effect-TS/effect-smol/commit/6f23f0ed4cba573cd9395c2e582f582fe7271544), [`654aaec`](https://github.com/Effect-TS/effect-smol/commit/654aaec593305521b65dd042c204d761cc6e8c28), [`2958a42`](https://github.com/Effect-TS/effect-smol/commit/2958a42078966a8713a98f00485ab36484d5eccf), [`95d27a2`](https://github.com/Effect-TS/effect-smol/commit/95d27a239ed5147302605ab0b3147a056541b0c7), [`0fbaea8`](https://github.com/Effect-TS/effect-smol/commit/0fbaea8f9555a8044cec31a770394db613fc78e2), [`21d5d5e`](https://github.com/Effect-TS/effect-smol/commit/21d5d5e0439fd4d9bb6e508377215b1087555d45), [`5a84853`](https://github.com/Effect-TS/effect-smol/commit/5a8485397b7f321ae021640c1999821143659462), [`6e49959`](https://github.com/Effect-TS/effect-smol/commit/6e499590357a104c81779b3176cd3f84e4f91064), [`8f5805d`](https://github.com/Effect-TS/effect-smol/commit/8f5805dbdd0d1bc0ff0727cc398c8d80e544edee), [`990df2c`](https://github.com/Effect-TS/effect-smol/commit/990df2c3ceeb32e659acc10cc9485617f7b3c423)]:
  - effect@4.0.0-beta.31

## 4.0.0-beta.30

### Patch Changes

- [#1679](https://github.com/Effect-TS/effect-smol/pull/1679) [`d440fd4`](https://github.com/Effect-TS/effect-smol/commit/d440fd4e79f5943998249f5e67fb42505bd20228) Thanks @tim-smart! - Add support for OpenAI `keepalive` response stream events.

- Updated dependencies [[`c88e5b7`](https://github.com/Effect-TS/effect-smol/commit/c88e5b723ff09da4edaef6ce14d927ca01104a32), [`947d0e4`](https://github.com/Effect-TS/effect-smol/commit/947d0e4268ba5c4020ead380aa80812c7342408f), [`7517908`](https://github.com/Effect-TS/effect-smol/commit/75179085d159b88a1ab0bce70669d76dcf0d79a4), [`a49ecd5`](https://github.com/Effect-TS/effect-smol/commit/a49ecd5a183d7e7d33f47ff95e9d2dea5a12ead5), [`6993e33`](https://github.com/Effect-TS/effect-smol/commit/6993e3329122c834c20bacea72d8678232f4f103), [`514f2a2`](https://github.com/Effect-TS/effect-smol/commit/514f2a2ae54580fcacdbe2ea2196a83a852d0748), [`3214b47`](https://github.com/Effect-TS/effect-smol/commit/3214b47676de2d33fddc5fecfc2d226e6e83cc7b), [`95ec5ed`](https://github.com/Effect-TS/effect-smol/commit/95ec5ed345de77c893049e182d37a37cf164a268)]:
  - effect@4.0.0-beta.30

## 4.0.0-beta.29

### Patch Changes

- Updated dependencies [[`9d93adb`](https://github.com/Effect-TS/effect-smol/commit/9d93adb1c1795d1978391b30d7d2972c88052662), [`b52721c`](https://github.com/Effect-TS/effect-smol/commit/b52721cf0d11a567722b060c8536e3bdd4161f07), [`a891c7b`](https://github.com/Effect-TS/effect-smol/commit/a891c7b12f415b2287613dd4b91a09dfd38ef30d), [`ef26cdf`](https://github.com/Effect-TS/effect-smol/commit/ef26cdfb65d9955fc7e161629191930c2cc2c63f), [`82fd3ed`](https://github.com/Effect-TS/effect-smol/commit/82fd3ed922063ee5a34f96f3993c15c7515e4f67)]:
  - effect@4.0.0-beta.29

## 4.0.0-beta.28

### Patch Changes

- Updated dependencies [[`ff533f2`](https://github.com/Effect-TS/effect-smol/commit/ff533f203cd06302ad08032a27e01269b4a2d4c6), [`dc803ee`](https://github.com/Effect-TS/effect-smol/commit/dc803ee52ebd3e9f931118f0dfcb804542847556), [`d660b1c`](https://github.com/Effect-TS/effect-smol/commit/d660b1c99cb93d4f79715e91c7a4486801c0eefa), [`93a05e3`](https://github.com/Effect-TS/effect-smol/commit/93a05e3eaa624058b162aedd66aad70102837270), [`2a65cf6`](https://github.com/Effect-TS/effect-smol/commit/2a65cf6fd81ef63d944e6fb51f058d439bf4a834), [`a561a40`](https://github.com/Effect-TS/effect-smol/commit/a561a40cc41c548c2cf3153aca065ee92ee8aa57), [`29cd24d`](https://github.com/Effect-TS/effect-smol/commit/29cd24d1fe78480a72eeb38a90281ffddc0530bc), [`662a8e6`](https://github.com/Effect-TS/effect-smol/commit/662a8e6857dac64a7cd13bd8df4b0674654622f8), [`d2b52ba`](https://github.com/Effect-TS/effect-smol/commit/d2b52bae5b9336cf59729fbdcc4d7f09512b0cbf), [`407c3b4`](https://github.com/Effect-TS/effect-smol/commit/407c3b43a5d1414558e0e33b6f1fc0e6a6d489cc), [`42bc7ce`](https://github.com/Effect-TS/effect-smol/commit/42bc7ce5480f6f2953c39f8cb5c850d61df6f5a2), [`e741322`](https://github.com/Effect-TS/effect-smol/commit/e74132226cbfee24234311c7c1c13e6b7391384e), [`5c75fa8`](https://github.com/Effect-TS/effect-smol/commit/5c75fa8fb71163bc4c035ba1a215574dfd4badfc), [`747177b`](https://github.com/Effect-TS/effect-smol/commit/747177b0602f12d4461a843e953dfdffbeb0a429), [`326cd48`](https://github.com/Effect-TS/effect-smol/commit/326cd4828bce573fe985f35152155464bf4c5a70), [`627e922`](https://github.com/Effect-TS/effect-smol/commit/627e922b8d1e9521eae5e1caa5d667ad00b1619a), [`662287e`](https://github.com/Effect-TS/effect-smol/commit/662287e9abc76c941ccc2ee330aa07904d571341)]:
  - effect@4.0.0-beta.28

## 4.0.0-beta.27

### Patch Changes

- Updated dependencies [[`903a839`](https://github.com/Effect-TS/effect-smol/commit/903a839e94239e6ec4568315af28e405bcad95f4), [`91a0168`](https://github.com/Effect-TS/effect-smol/commit/91a016836680a6669308ecf464d3584bcc4ae1b7), [`c890f9a`](https://github.com/Effect-TS/effect-smol/commit/c890f9a1b3a989ed22528bd5a43326342e05b142), [`1e985f2`](https://github.com/Effect-TS/effect-smol/commit/1e985f237d250b51b91de22dde77160c1e778ce7)]:
  - effect@4.0.0-beta.27

## 4.0.0-beta.26

### Patch Changes

- Updated dependencies [[`fb21462`](https://github.com/Effect-TS/effect-smol/commit/fb21462642cdd5b1bada92f3eba18ae20445be42), [`2ed26b1`](https://github.com/Effect-TS/effect-smol/commit/2ed26b139805700e3df39efaa768ff01565e5c86), [`e832a57`](https://github.com/Effect-TS/effect-smol/commit/e832a57b570fe38f010c1fd99bceac5a325a9e07), [`7f01be7`](https://github.com/Effect-TS/effect-smol/commit/7f01be7f8db363d4b2e88e6b5571e96bb815786f), [`e965143`](https://github.com/Effect-TS/effect-smol/commit/e9651431e114479e6becf8ca7b1ed99ac7e91ccc), [`b9b80f1`](https://github.com/Effect-TS/effect-smol/commit/b9b80f1f15e152ceef0a727d150b7dc230abae99), [`98252aa`](https://github.com/Effect-TS/effect-smol/commit/98252aa0c0b17fc73fbdad65d0a1104965f9fc0f), [`56fbd94`](https://github.com/Effect-TS/effect-smol/commit/56fbd94311ad19a05001ad649d9e34ab00c74541), [`3faa109`](https://github.com/Effect-TS/effect-smol/commit/3faa109b7d093fbf14ad410d3e11d663f16e28f1), [`692ecfe`](https://github.com/Effect-TS/effect-smol/commit/692ecfed99fe58056b7a5afe001f4fcd1a61c446), [`1e70b72`](https://github.com/Effect-TS/effect-smol/commit/1e70b72d0b210474d0e96a15a5cfc279eae37e0c), [`ecf0782`](https://github.com/Effect-TS/effect-smol/commit/ecf07829ef2dfc01d8943c96c4fe9c1b44b97926)]:
  - effect@4.0.0-beta.26

## 4.0.0-beta.25

### Patch Changes

- Updated dependencies [[`fa17bb5`](https://github.com/Effect-TS/effect-smol/commit/fa17bb5be9f2533d01e11322b14804c7dec43714), [`f46e5b5`](https://github.com/Effect-TS/effect-smol/commit/f46e5b5ca2a918ee4d9270167e79db223077c96f), [`ce4767c`](https://github.com/Effect-TS/effect-smol/commit/ce4767cadcacc6ce8ff4c3a0d0fbc82ede655f63), [`c830a8b`](https://github.com/Effect-TS/effect-smol/commit/c830a8b6c292a6528d7f9318759d34800b00372d)]:
  - effect@4.0.0-beta.25

## 4.0.0-beta.24

### Patch Changes

- Updated dependencies [[`a909e1c`](https://github.com/Effect-TS/effect-smol/commit/a909e1c1ac2bc707527f5073776e3e7d239688d9), [`8814a4e`](https://github.com/Effect-TS/effect-smol/commit/8814a4ef78d67144d27689370af10099ea210399), [`3f942c5`](https://github.com/Effect-TS/effect-smol/commit/3f942c51cefa7b2ffa7c49e8c8a2c887570ba4c0), [`774ed59`](https://github.com/Effect-TS/effect-smol/commit/774ed59c52b2ab578bbb897c4f551f812231e1d2), [`f54b8d3`](https://github.com/Effect-TS/effect-smol/commit/f54b8d398fedad1815fd1f4c49814ab938cfc385)]:
  - effect@4.0.0-beta.24

## 4.0.0-beta.23

### Patch Changes

- Updated dependencies [[`5c73c41`](https://github.com/Effect-TS/effect-smol/commit/5c73c41b69eaeab80fcd62c9bfda490b446d1966)]:
  - effect@4.0.0-beta.23

## 4.0.0-beta.22

### Patch Changes

- Updated dependencies [[`0874332`](https://github.com/Effect-TS/effect-smol/commit/0874332f7c81118b06ac2eb105e0710211631479), [`c592dcd`](https://github.com/Effect-TS/effect-smol/commit/c592dcde0697e322065c8f418c0480ef910cb183), [`1dbe28d`](https://github.com/Effect-TS/effect-smol/commit/1dbe28dac8299cd3e218c9768450cfd173b5e294), [`564d730`](https://github.com/Effect-TS/effect-smol/commit/564d730b6bbf38dd8548a3b046e7a693b28699a4), [`3cfadc4`](https://github.com/Effect-TS/effect-smol/commit/3cfadc458b070c6cba6c5674b72a059f1e49118b), [`6634fd0`](https://github.com/Effect-TS/effect-smol/commit/6634fd07da067d80b8261fb2959d1a952b9e412e), [`d10dabe`](https://github.com/Effect-TS/effect-smol/commit/d10dabeb7af9a368f995829cd36ad08167cd8f95), [`f82f549`](https://github.com/Effect-TS/effect-smol/commit/f82f549a09e950e9d4987f279a800f4d953f0939), [`78a3382`](https://github.com/Effect-TS/effect-smol/commit/78a3382ddfbe034408f7480fa794733d9e82147b)]:
  - effect@4.0.0-beta.22

## 4.0.0-beta.21

### Patch Changes

- Updated dependencies [[`e691909`](https://github.com/Effect-TS/effect-smol/commit/e691909495ccb162ea7bfa351dd74632b99997cb), [`d5f413f`](https://github.com/Effect-TS/effect-smol/commit/d5f413f3c8fc57f2413cc5649c2003d6d4e5a6d7), [`139d152`](https://github.com/Effect-TS/effect-smol/commit/139d152941e562a073b5be12e8d66c8a4d4a8a57), [`947e3d4`](https://github.com/Effect-TS/effect-smol/commit/947e3d436ab8a017efda9b29be523efd1ca8df28), [`84b2cce`](https://github.com/Effect-TS/effect-smol/commit/84b2ccefe2aa3a7413b86738a4dc33cdb311ca55), [`7f5305e`](https://github.com/Effect-TS/effect-smol/commit/7f5305e69f5a33309e77b08a576edb25d7daaee2), [`9e6fd84`](https://github.com/Effect-TS/effect-smol/commit/9e6fd8471c93a3c643929151a3bdb62cb9c0ca0e), [`fdb8a4b`](https://github.com/Effect-TS/effect-smol/commit/fdb8a4b172721fbefe98bd5aa6fe4f0efd1da3eb), [`0f986ef`](https://github.com/Effect-TS/effect-smol/commit/0f986ef22f196fe091a7afdbd179485a7d888882), [`9355fc0`](https://github.com/Effect-TS/effect-smol/commit/9355fc0ffb5b7382146a5aed9eea83974b10d007)]:
  - effect@4.0.0-beta.21

## 4.0.0-beta.20

### Patch Changes

- [#1529](https://github.com/Effect-TS/effect-smol/pull/1529) [`e542c94`](https://github.com/Effect-TS/effect-smol/commit/e542c942bee4729138b02222f4421220a90a57d8) Thanks @tim-smart! - Add dedicated AiError metadata interfaces per reason so provider packages can safely augment metadata without conflicting module declarations.

- [#1528](https://github.com/Effect-TS/effect-smol/pull/1528) [`6f4ebd1`](https://github.com/Effect-TS/effect-smol/commit/6f4ebd193c2595983394127dd808601b75430d34) Thanks @tim-smart! - Add `Model.ModelName` and provide it from AI model constructors.

- Updated dependencies [[`842a624`](https://github.com/Effect-TS/effect-smol/commit/842a624f79d5e1407460b0ef3ab27d14d48ccf74), [`4785eef`](https://github.com/Effect-TS/effect-smol/commit/4785eef5d7cf1edb96ef2509aed2ba4d1edf3862), [`8fac95b`](https://github.com/Effect-TS/effect-smol/commit/8fac95bd9e0338b7a82da8da579c1ac22afa045c), [`12ee8e2`](https://github.com/Effect-TS/effect-smol/commit/12ee8e27df7eb393d83a5e403390d0cfc82ca732), [`e542c94`](https://github.com/Effect-TS/effect-smol/commit/e542c942bee4729138b02222f4421220a90a57d8), [`8fac95b`](https://github.com/Effect-TS/effect-smol/commit/8fac95bd9e0338b7a82da8da579c1ac22afa045c), [`6f4ebd1`](https://github.com/Effect-TS/effect-smol/commit/6f4ebd193c2595983394127dd808601b75430d34), [`989d1cc`](https://github.com/Effect-TS/effect-smol/commit/989d1cca936fce0cc459057825ba40e3f5ef3827)]:
  - effect@4.0.0-beta.20

## 4.0.0-beta.19

### Patch Changes

- [#1522](https://github.com/Effect-TS/effect-smol/pull/1522) [`19984c2`](https://github.com/Effect-TS/effect-smol/commit/19984c2c1b23ef06d69f9bbd4c4ad992a03c6860) Thanks @IMax153! - Fix missing `yield*` in `OpenAiLanguageModel.prepareResponseFormat`

- Updated dependencies []:
  - effect@4.0.0-beta.19

## 4.0.0-beta.18

### Patch Changes

- [#1520](https://github.com/Effect-TS/effect-smol/pull/1520) [`725260b`](https://github.com/Effect-TS/effect-smol/commit/725260b53f5142d6af7a93a2f9f464f974eda92d) Thanks @IMax153! - Ensure that OpenAI JSON schemas for tool calls and structured outputs are properly transformed

- Updated dependencies [[`01e31fd`](https://github.com/Effect-TS/effect-smol/commit/01e31fdf8e5206849d23cbafd23a346f2f177ab8), [`0890aab`](https://github.com/Effect-TS/effect-smol/commit/0890aab15ed9c5ba52c383a72fdc6a444d7504d5), [`725260b`](https://github.com/Effect-TS/effect-smol/commit/725260b53f5142d6af7a93a2f9f464f974eda92d)]:
  - effect@4.0.0-beta.18

## 4.0.0-beta.17

### Patch Changes

- Updated dependencies [[`8f59c32`](https://github.com/Effect-TS/effect-smol/commit/8f59c32922597a48392744f7203e284866747781)]:
  - effect@4.0.0-beta.17

## 4.0.0-beta.16

### Patch Changes

- Updated dependencies [[`bf9096c`](https://github.com/Effect-TS/effect-smol/commit/bf9096c52a7d8791d93d232739e523eb84f6625a), [`29f81ca`](https://github.com/Effect-TS/effect-smol/commit/29f81ca07c67dba265804b140a7487fb15a5fc6b), [`68eb28c`](https://github.com/Effect-TS/effect-smol/commit/68eb28c2b0fc67a9f6204ade9bd16c5b37803bfb)]:
  - effect@4.0.0-beta.16

## 4.0.0-beta.15

### Patch Changes

- [#1502](https://github.com/Effect-TS/effect-smol/pull/1502) [`285b7e6`](https://github.com/Effect-TS/effect-smol/commit/285b7e667167566d5788367d5155b19c79f1bf22) Thanks @tim-smart! - allow undefined for ai config

- Updated dependencies [[`24ae609`](https://github.com/Effect-TS/effect-smol/commit/24ae60995d2fd7d621be356cdfdfd328c79639ba), [`0e3c059`](https://github.com/Effect-TS/effect-smol/commit/0e3c059987caa55ebd0c134f7c7b147c639c328e), [`e843b0a`](https://github.com/Effect-TS/effect-smol/commit/e843b0a7d7e7b600a0b3bd477f24e2e4cd26bc8b), [`f4389a2`](https://github.com/Effect-TS/effect-smol/commit/f4389a2cca3c5bbf00d69779f52ce41255f15a28), [`5b73de0`](https://github.com/Effect-TS/effect-smol/commit/5b73de095b3402d0c5c74092ace6ce18ebfad566), [`595d2d6`](https://github.com/Effect-TS/effect-smol/commit/595d2d6e7d50419f3532bd39266191532ace38f2)]:
  - effect@4.0.0-beta.15

## 4.0.0-beta.14

### Patch Changes

- Updated dependencies [[`c414700`](https://github.com/Effect-TS/effect-smol/commit/c414700ef1932e4b67d0102856de417336912350), [`a30c969`](https://github.com/Effect-TS/effect-smol/commit/a30c9699c0d736cf3952041e45d508b7d58907a9)]:
  - effect@4.0.0-beta.14

## 4.0.0-beta.13

### Patch Changes

- Updated dependencies [[`368f4c3`](https://github.com/Effect-TS/effect-smol/commit/368f4c363dd117e6f5a19ad77b161176cfd29fdd), [`db8a579`](https://github.com/Effect-TS/effect-smol/commit/db8a579e93e93ff73b1e60712732e03b597b916b), [`668b703`](https://github.com/Effect-TS/effect-smol/commit/668b70337e9ddbb0d1ae2282a95c282ce404e562), [`d40e76b`](https://github.com/Effect-TS/effect-smol/commit/d40e76b973543979e60e04a6baca04a8c65bdfc2), [`6e18cf8`](https://github.com/Effect-TS/effect-smol/commit/6e18cf883e9905ca718a6697b6a2a4bbd42739aa), [`86062e8`](https://github.com/Effect-TS/effect-smol/commit/86062e8a0c61bca5412fc40d2cf151d676901f08), [`c27ce75`](https://github.com/Effect-TS/effect-smol/commit/c27ce75d34c74dcfc6dba1bf77f1ce88f410a0de), [`e2d4fbf`](https://github.com/Effect-TS/effect-smol/commit/e2d4fbfeeda6a5d2a4c5aeb0501d8240c248b9eb), [`114ab42`](https://github.com/Effect-TS/effect-smol/commit/114ab42ad0edc590d29169675a493e0e915aa58f), [`484caec`](https://github.com/Effect-TS/effect-smol/commit/484caec47cccac8b86db2910742e406dfc7173ab)]:
  - effect@4.0.0-beta.13

## 4.0.0-beta.12

### Patch Changes

- Updated dependencies [[`70a74e8`](https://github.com/Effect-TS/effect-smol/commit/70a74e88a8767c9d4acdb9e5f25aec9a33588d07), [`b5b6e10`](https://github.com/Effect-TS/effect-smol/commit/b5b6e10621d54bf8c9857fec0d647ced78ecd857), [`f5ce5a9`](https://github.com/Effect-TS/effect-smol/commit/f5ce5a915359c6ebf254079e1da23cab6cde34fb), [`a29eb70`](https://github.com/Effect-TS/effect-smol/commit/a29eb702ffe3fc58bd28c4d7857298cd65d73668), [`c7b36e5`](https://github.com/Effect-TS/effect-smol/commit/c7b36e541a23e9a00f64e25b23851e51a37dfce5), [`9381d6d`](https://github.com/Effect-TS/effect-smol/commit/9381d6d4d9d819a81a46e56d0364c76e92a4fbca), [`88439f1`](https://github.com/Effect-TS/effect-smol/commit/88439f13ca13549f3e4822c48c4f019c14fc2bcc), [`e35307d`](https://github.com/Effect-TS/effect-smol/commit/e35307dbeb8eb26a9923f958b894a8eaaf259bf2), [`c7df4bc`](https://github.com/Effect-TS/effect-smol/commit/c7df4bce34009474c63d62a807abfdafb76971eb), [`accaf3b`](https://github.com/Effect-TS/effect-smol/commit/accaf3be7ac8da36e2334c509c23b8c9e88ea160), [`3e1c270`](https://github.com/Effect-TS/effect-smol/commit/3e1c2707bbdf67720af1509642b8ced195790882), [`6cd81f7`](https://github.com/Effect-TS/effect-smol/commit/6cd81f73baad86f5bbfa455a55d75cde71e9611a), [`f222da3`](https://github.com/Effect-TS/effect-smol/commit/f222da3cdb44554f3324c2c52d0d005ee575053e), [`61f901d`](https://github.com/Effect-TS/effect-smol/commit/61f901d830005b66e22d1de889fda132aeea97cd)]:
  - effect@4.0.0-beta.12

## 4.0.0-beta.11

### Patch Changes

- Updated dependencies [[`88659ed`](https://github.com/Effect-TS/effect-smol/commit/88659edb26e3623d557dccfe914c2c949672da16), [`f2915e8`](https://github.com/Effect-TS/effect-smol/commit/f2915e8e2efe80d50c281e53f297b9701d6dc199), [`eb71ace`](https://github.com/Effect-TS/effect-smol/commit/eb71acebbe0f228e4920278013beee3b67d62310), [`2a16999`](https://github.com/Effect-TS/effect-smol/commit/2a169996c7513d377ac47adbfd68e1490457135c), [`d42dd52`](https://github.com/Effect-TS/effect-smol/commit/d42dd52f11203f8e749fb5d3ecf7153e4a5a6814), [`339adaf`](https://github.com/Effect-TS/effect-smol/commit/339adaf850a62a892adebcb208c2d9dddf3b97b3), [`de19645`](https://github.com/Effect-TS/effect-smol/commit/de1964526d01102dd1cb99c8cfdd3e8df1f49ef1), [`9b1dc3b`](https://github.com/Effect-TS/effect-smol/commit/9b1dc3bcf2a1b68d0a67e3465db5ad01a1a56997), [`e4cb2f5`](https://github.com/Effect-TS/effect-smol/commit/e4cb2f55b30f4771ec1bf613ced36d6d96464dd5), [`8bced95`](https://github.com/Effect-TS/effect-smol/commit/8bced954ecb35d4489197a57b0efe927e7d75f49), [`9431420`](https://github.com/Effect-TS/effect-smol/commit/94314207c8019918200fbcb97aec992219f801f0), [`948dca2`](https://github.com/Effect-TS/effect-smol/commit/948dca22e4f672ba7a6db57f9899272bec7c08b8), [`d18e327`](https://github.com/Effect-TS/effect-smol/commit/d18e32765a2665e31ffb31e746bf983fcfac34c5), [`ab512f7`](https://github.com/Effect-TS/effect-smol/commit/ab512f7be1c0e6b359da921e22cd4944e4c57d3e)]:
  - effect@4.0.0-beta.11

## 4.0.0-beta.10

### Patch Changes

- Updated dependencies [[`371acab`](https://github.com/Effect-TS/effect-smol/commit/371acabb58d56f3a7a5e3e33d3d5fdc9f5573c74), [`856d774`](https://github.com/Effect-TS/effect-smol/commit/856d7741f1e296dd5048c6ff2b44b95d023e6ae4), [`b9e9202`](https://github.com/Effect-TS/effect-smol/commit/b9e92023c38caa322975d77cfe83e2d34ac9305a), [`1d1a974`](https://github.com/Effect-TS/effect-smol/commit/1d1a974bd280c81bff5d4505491cda03ba7a3f36), [`6bfe2a6`](https://github.com/Effect-TS/effect-smol/commit/6bfe2a659bc6335db75709931f405da45301cba2), [`b12c811`](https://github.com/Effect-TS/effect-smol/commit/b12c81157be287b1649c210616a244b50ec094d2), [`d17d98a`](https://github.com/Effect-TS/effect-smol/commit/d17d98ad78e2b44d95ef434adab79ac3c35e75ab), [`68c3c7c`](https://github.com/Effect-TS/effect-smol/commit/68c3c7cb1e06ed94fa5c4c123a234b4ccbfdecd8)]:
  - effect@4.0.0-beta.10

## 4.0.0-beta.9

### Patch Changes

- Updated dependencies [[`3386557`](https://github.com/Effect-TS/effect-smol/commit/338655731564a7be9f8859dedbf4d5bcac6eb350), [`b6666e3`](https://github.com/Effect-TS/effect-smol/commit/b6666e3cf6bd44ba1a8704e65c256c30359cb422)]:
  - effect@4.0.0-beta.9

## 4.0.0-beta.8

### Patch Changes

- [#1354](https://github.com/Effect-TS/effect-smol/pull/1354) [`b94962c`](https://github.com/Effect-TS/effect-smol/commit/b94962c249d46cf96cdf2e41188dc9feda41536a) Thanks @IMax153! - Fix the generated schemas for ai providers

- Updated dependencies [[`246e672`](https://github.com/Effect-TS/effect-smol/commit/246e672dbbd7848d60e0c78fd66671b2f10b3752), [`807dec0`](https://github.com/Effect-TS/effect-smol/commit/807dec03801b4c58a6d00c237b6d98d6386911df)]:
  - effect@4.0.0-beta.8

## 4.0.0-beta.7

### Patch Changes

- Updated dependencies [[`a2bda6d`](https://github.com/Effect-TS/effect-smol/commit/a2bda6d4ef6de9d9b0c53ae2df5434f778d6161a), [`1f95a2b`](https://github.com/Effect-TS/effect-smol/commit/1f95a2b5aa9524bb38f4437f4691a664bf463ca1), [`a8d5e79`](https://github.com/Effect-TS/effect-smol/commit/a8d5e792fec201a83af0eb92fc79928d055125fd), [`a5386ba`](https://github.com/Effect-TS/effect-smol/commit/a5386ba67005dff697d45a45398f398773f58dcf), [`a5386ba`](https://github.com/Effect-TS/effect-smol/commit/a5386ba67005dff697d45a45398f398773f58dcf), [`06d8a03`](https://github.com/Effect-TS/effect-smol/commit/06d8a0391631e6130e3ab25227e59817852e227f), [`8caac76`](https://github.com/Effect-TS/effect-smol/commit/8caac76a35821edfe03c75dab5eb056e8fc05430), [`8caac76`](https://github.com/Effect-TS/effect-smol/commit/8caac76a35821edfe03c75dab5eb056e8fc05430), [`f9e883e`](https://github.com/Effect-TS/effect-smol/commit/f9e883e266fbda870336ee62f46b7ac85ba3de6e), [`8caac76`](https://github.com/Effect-TS/effect-smol/commit/8caac76a35821edfe03c75dab5eb056e8fc05430)]:
  - effect@4.0.0-beta.7

## 4.0.0-beta.6

### Patch Changes

- Updated dependencies [[`3247da2`](https://github.com/Effect-TS/effect-smol/commit/3247da28331f345f68be5dbd2974a7e03d300fe1), [`f205705`](https://github.com/Effect-TS/effect-smol/commit/f2057050dbd034b8c186be2d40c3d03ee63a5a3b), [`f35022c`](https://github.com/Effect-TS/effect-smol/commit/f35022c212e4111527e1bb43f360a67b2b49fa85), [`8622721`](https://github.com/Effect-TS/effect-smol/commit/86227217b02d43680a3c6f3c21731b1d852c91f5), [`fc660ab`](https://github.com/Effect-TS/effect-smol/commit/fc660ab8b5ebae38b8d6b96cbf2f9b880cc09253), [`f37dc33`](https://github.com/Effect-TS/effect-smol/commit/f37dc335f64622fa9ce8d6d1d5dd8fc3f260257b), [`3662f32`](https://github.com/Effect-TS/effect-smol/commit/3662f328fcfa3b2fa01ffa79da40e12e93fcede8), [`a7d436f`](https://github.com/Effect-TS/effect-smol/commit/a7d436f438dcd7f49b9485e4e95a4511f31fad7d), [`6856a41`](https://github.com/Effect-TS/effect-smol/commit/6856a415d7eddd9d73d60919e976f1d071421be4), [`8c417d0`](https://github.com/Effect-TS/effect-smol/commit/8c417d03475e5e12d00dca0c4781d0af7e66b86c), [`5419570`](https://github.com/Effect-TS/effect-smol/commit/5419570ba47ce882a3a10882707b46f66e464906), [`449c5ed`](https://github.com/Effect-TS/effect-smol/commit/449c5ed5318e8a874e730420bcf52918fa2ec80f), [`4b5ec12`](https://github.com/Effect-TS/effect-smol/commit/4b5ec12f87f95f2a3cd8fe4d5b26c6eb0529381a), [`df87937`](https://github.com/Effect-TS/effect-smol/commit/df879375fc3b169c43f9c434b3775e12b80dffe4), [`5dbfca8`](https://github.com/Effect-TS/effect-smol/commit/5dbfca8d1dbb6d18d1605d4f8562e99c86e2ff11), [`e629497`](https://github.com/Effect-TS/effect-smol/commit/e6294973d55597ab6b6deca6babbe1e946b2c91d), [`981c991`](https://github.com/Effect-TS/effect-smol/commit/981c991cd78db34def815d5754379d737157f005), [`1ca2ed6`](https://github.com/Effect-TS/effect-smol/commit/1ca2ed67301a5dc40ae0ed94346b99f26fd22bbe), [`45722bd`](https://github.com/Effect-TS/effect-smol/commit/45722bde974458311f11ad237711363a10ec6894), [`eb2a85e`](https://github.com/Effect-TS/effect-smol/commit/eb2a85ed4dc162b2535d304799333a5a20477fd0)]:
  - effect@4.0.0-beta.6

## 4.0.0-beta.5

### Patch Changes

- Updated dependencies [[`f6e133e`](https://github.com/Effect-TS/effect-smol/commit/f6e133e9a16b32317bd09ff08c12b97a0ae44600), [`e3893cc`](https://github.com/Effect-TS/effect-smol/commit/e3893ccf2632338c7d8e745f639dcd825a9d42f8), [`a88e206`](https://github.com/Effect-TS/effect-smol/commit/a88e206e44dc66ca5a2b45bedc797877c5dbb083), [`e3893cc`](https://github.com/Effect-TS/effect-smol/commit/e3893ccf2632338c7d8e745f639dcd825a9d42f8)]:
  - effect@4.0.0-beta.5

## 4.0.0-beta.4

### Patch Changes

- Updated dependencies [[`c5a18ef`](https://github.com/Effect-TS/effect-smol/commit/c5a18ef44171e3880bf983faee74529908974b32), [`bc6b885`](https://github.com/Effect-TS/effect-smol/commit/bc6b885b94d887a200657c0775dfa874dc15bc0c)]:
  - effect@4.0.0-beta.4

## 4.0.0-beta.3

### Patch Changes

- Updated dependencies [[`3a0cf36`](https://github.com/Effect-TS/effect-smol/commit/3a0cf36eff106ba48d74e133c1598cd40613e530), [`c4da328`](https://github.com/Effect-TS/effect-smol/commit/c4da328d32fad1d61e0e538f5d371edf61521d7e)]:
  - effect@4.0.0-beta.3

## 4.0.0-beta.2

### Patch Changes

- Updated dependencies [[`a22ce73`](https://github.com/Effect-TS/effect-smol/commit/a22ce73b2bd9305b7ba665694d2255c0e6d5a8d0), [`ebdabf7`](https://github.com/Effect-TS/effect-smol/commit/ebdabf79ff4e62c8384aa8cf9a8d2787d536ee78), [`8f663bb`](https://github.com/Effect-TS/effect-smol/commit/8f663bb121021bf12bd264e8ae385187cb7a5dae)]:
  - effect@4.0.0-beta.2

## 4.0.0-beta.1

### Patch Changes

- Updated dependencies [[`0fecf70`](https://github.com/Effect-TS/effect-smol/commit/0fecf70048057623eed7c584a06671773a2b1743), [`709569e`](https://github.com/Effect-TS/effect-smol/commit/709569ed76bead9ebb0670599e4d890a07ca5a43)]:
  - effect@4.0.0-beta.1

## 4.0.0-beta.0

### Major Changes

- [#1183](https://github.com/Effect-TS/effect-smol/pull/1183) [`be642ab`](https://github.com/Effect-TS/effect-smol/commit/be642ab1b3b4cd49e53c9732d7aba1b367fddd66) Thanks @tim-smart! - v4 beta

### Patch Changes

- Updated dependencies [[`be642ab`](https://github.com/Effect-TS/effect-smol/commit/be642ab1b3b4cd49e53c9732d7aba1b367fddd66)]:
  - effect@4.0.0-beta.0
