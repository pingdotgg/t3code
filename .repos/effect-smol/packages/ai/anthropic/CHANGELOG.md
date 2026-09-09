# @effect/ai-anthropic

## 4.0.0-rc.112

### Patch Changes

- [#7437](https://github.com/Effect-TS/effect/pull/7437) [`44675cb`](https://github.com/Effect-TS/effect/commit/44675cbce3dabfb85c68a3703b5de525768336fb) Thanks @wmaurer! - Add an optional `description` to `AiError.AuthenticationError`, rendered after the kind-based suggestion, and pass the provider's own error text through it on HTTP 401 and 403, so authentication failures report what actually went wrong instead of only a category.
- Updated dependencies [[`20cb4f2`](https://github.com/Effect-TS/effect/commit/20cb4f260e45d37fa417c292c57be015314efe16), [`44675cb`](https://github.com/Effect-TS/effect/commit/44675cbce3dabfb85c68a3703b5de525768336fb), [`b6bf5e1`](https://github.com/Effect-TS/effect/commit/b6bf5e14492643076454131148f97cde24ad5306), [`0b9f780`](https://github.com/Effect-TS/effect/commit/0b9f780ff28b71042241791a9e8bcb5b631be2bd), [`150e92c`](https://github.com/Effect-TS/effect/commit/150e92c4169c245e701da02575eef0b69c3ecd64), [`6740db2`](https://github.com/Effect-TS/effect/commit/6740db247ed20cb85da43c9f48ade8fecfd8c1ae), [`d57bba1`](https://github.com/Effect-TS/effect/commit/d57bba1486fa60971b6e0bf7459a329cfd5acdc4), [`be75d5e`](https://github.com/Effect-TS/effect/commit/be75d5ea6e516c25e3affec25806d31c2b203bc4), [`be75d5e`](https://github.com/Effect-TS/effect/commit/be75d5ea6e516c25e3affec25806d31c2b203bc4), [`be75d5e`](https://github.com/Effect-TS/effect/commit/be75d5ea6e516c25e3affec25806d31c2b203bc4), [`02a5146`](https://github.com/Effect-TS/effect/commit/02a5146d6933c7f6052553550bce5658225e4100), [`15272a6`](https://github.com/Effect-TS/effect/commit/15272a66adf02501e7747761e2a3c41bff67bb46), [`436f10d`](https://github.com/Effect-TS/effect/commit/436f10d1efccec308426532ff3f88df9a96434f3), [`058fb15`](https://github.com/Effect-TS/effect/commit/058fb15647fa01ad771277bd368783fcf5f262e8), [`4d89bb8`](https://github.com/Effect-TS/effect/commit/4d89bb8ffb4cf567a1d11072246b6161ce638712), [`480fb15`](https://github.com/Effect-TS/effect/commit/480fb156590785cf98f67bdec4fc282a608e2d87), [`f77ec19`](https://github.com/Effect-TS/effect/commit/f77ec19cff1cbbeeae928e3bd0ece00a7d22bab8), [`925b82a`](https://github.com/Effect-TS/effect/commit/925b82a81f59a4d459b488621030f24ba99d6a27), [`7455246`](https://github.com/Effect-TS/effect/commit/7455246f352385f5cbbdd8299555265ee289490e), [`118124d`](https://github.com/Effect-TS/effect/commit/118124d913d0a02ac5c1f7799a39bd90031769d9), [`a5f78d3`](https://github.com/Effect-TS/effect/commit/a5f78d3fcbaa792d49e80d103ab438e0b50812fd), [`0dd7825`](https://github.com/Effect-TS/effect/commit/0dd7825e4da4d3a00fa9bd410a1d55f3d4874d07), [`b722eca`](https://github.com/Effect-TS/effect/commit/b722eca6d283a88970ad0efba0b4e921915eca78), [`811d579`](https://github.com/Effect-TS/effect/commit/811d579c432856a9e3fc05b517fd8e924cbf991a), [`043b587`](https://github.com/Effect-TS/effect/commit/043b587e6e93f6624bf974bcd7ed976eaa17f0e1), [`8583727`](https://github.com/Effect-TS/effect/commit/85837274fa929a921985464585513a68c261e365), [`d9d2cfc`](https://github.com/Effect-TS/effect/commit/d9d2cfcb732754001b7323cf8afaccc48539bb74), [`5c4b7a0`](https://github.com/Effect-TS/effect/commit/5c4b7a0b17931cd1538c6595a54b21ffe9c1e906)]:
  - effect@4.0.0-rc.112

## 4.0.0-rc.111

### Patch Changes

- Updated dependencies [[`0ce3b00`](https://github.com/Effect-TS/effect/commit/0ce3b007531563ce33f94c6a057492d379cfd9e8), [`d846331`](https://github.com/Effect-TS/effect/commit/d84633171b4333e87a05f8d74c02c95d83d1b50d), [`f93616f`](https://github.com/Effect-TS/effect/commit/f93616f31f42345af844b8396fb19259556ae236), [`16bf1ef`](https://github.com/Effect-TS/effect/commit/16bf1efdf41ba1d000b8588a8cc052a394856ba4), [`d568968`](https://github.com/Effect-TS/effect/commit/d5689682e963f43157571cd71d4b422247ae09b9), [`bc06292`](https://github.com/Effect-TS/effect/commit/bc062920ac47f956786d12c6d0bacb9468fa66e2), [`e03ea90`](https://github.com/Effect-TS/effect/commit/e03ea907720b58d19d99929695df159c42fff101), [`9b10fc8`](https://github.com/Effect-TS/effect/commit/9b10fc85dde7866fb60e8142a93a6ed6a184537c), [`770c6d0`](https://github.com/Effect-TS/effect/commit/770c6d0f0ddcab7dbdde9fe701aded08deaee3fd), [`7425bcb`](https://github.com/Effect-TS/effect/commit/7425bcb7f74bdccc1941883bc7f9472fbe6ae8b4), [`563815a`](https://github.com/Effect-TS/effect/commit/563815a250e10a02e2a719c7d9b159478b0da933), [`1e83ca1`](https://github.com/Effect-TS/effect/commit/1e83ca110d5cb74641bae148a08e7eb6b3c2e2ed), [`550a41a`](https://github.com/Effect-TS/effect/commit/550a41a2547ce0dd5f085f1637a6f8a5794acba7), [`45d79c7`](https://github.com/Effect-TS/effect/commit/45d79c7cbd9c56c643361c6e6d1689f1aa62ae32), [`aac8584`](https://github.com/Effect-TS/effect/commit/aac8584fd997f3ce3341aeb077b816219832de58), [`7f87022`](https://github.com/Effect-TS/effect/commit/7f870225bb10a7ee7cb54b4835cb3bf64c0cacd8), [`425457c`](https://github.com/Effect-TS/effect/commit/425457c1e9eec7c176df130f7ec6ad3d616c086e), [`008c423`](https://github.com/Effect-TS/effect/commit/008c423e413fe311085c4bfc07c19b9c70529dfa), [`4f6ae04`](https://github.com/Effect-TS/effect/commit/4f6ae041a2886c27e941c5d9e4916aa2a32e0a1c), [`b6b63e1`](https://github.com/Effect-TS/effect/commit/b6b63e151595b5599ad2d65069ab6d298cfd7be7), [`92922ee`](https://github.com/Effect-TS/effect/commit/92922ee7de0a2d932121e37677f3e75ea38482f1), [`859c02f`](https://github.com/Effect-TS/effect/commit/859c02fe9020b0f28f713aa85910a0cc2d002560), [`ffc8235`](https://github.com/Effect-TS/effect/commit/ffc823537a0925171cf41d0841643a0b26895a4c), [`a29eb70`](https://github.com/Effect-TS/effect/commit/a29eb702ffe3fc58bd28c4d7857298cd65d73668), [`0be2303`](https://github.com/Effect-TS/effect/commit/0be2303dd39f9f2f7d8f96a28e25c938cd914e1a), [`b44636f`](https://github.com/Effect-TS/effect/commit/b44636ff7233763fad060bc0f9de10512454a29b), [`b19ccc7`](https://github.com/Effect-TS/effect/commit/b19ccc7325469a5dea091349bda4ae2ec00ec865), [`ff98f0b`](https://github.com/Effect-TS/effect/commit/ff98f0b0e2beb331209e37e42095d8d6e8e0b6c2), [`a47cbf1`](https://github.com/Effect-TS/effect/commit/a47cbf1feafd10e305c9753fa02a5f5f977d2c37), [`39b55f8`](https://github.com/Effect-TS/effect/commit/39b55f850aecbecf2e3b0c5f3ae2d1a77e6da949), [`c6c49c9`](https://github.com/Effect-TS/effect/commit/c6c49c96990d009341341a53ed26beb140c267a9), [`bf23ba7`](https://github.com/Effect-TS/effect/commit/bf23ba7033a4b426caf379bdcf84c58bb64d7010)]:
  - effect@4.0.0-rc.111

## 4.0.0-rc.110

### Patch Changes

- Updated dependencies [[`6eebd0a`](https://github.com/Effect-TS/effect/commit/6eebd0a618308a91f95947bae6e0fb206ae3939d), [`6eebd0a`](https://github.com/Effect-TS/effect/commit/6eebd0a618308a91f95947bae6e0fb206ae3939d), [`d10ceb0`](https://github.com/Effect-TS/effect/commit/d10ceb06d56108c11100868f591d2b42ddff5e9f), [`d10ceb0`](https://github.com/Effect-TS/effect/commit/d10ceb06d56108c11100868f591d2b42ddff5e9f), [`d10ceb0`](https://github.com/Effect-TS/effect/commit/d10ceb06d56108c11100868f591d2b42ddff5e9f), [`189b003`](https://github.com/Effect-TS/effect/commit/189b003a2367fa44dd4b8544aa62979f0345d179), [`189b003`](https://github.com/Effect-TS/effect/commit/189b003a2367fa44dd4b8544aa62979f0345d179), [`0a127b8`](https://github.com/Effect-TS/effect/commit/0a127b8847fb213d46621a5018c069019414c00d), [`e491deb`](https://github.com/Effect-TS/effect/commit/e491deb1cd1717bc442aaee96e5d7b4001710cc9), [`f99c508`](https://github.com/Effect-TS/effect/commit/f99c508a09e9fccddb09edd16fa3393891c55d48), [`7e3f07c`](https://github.com/Effect-TS/effect/commit/7e3f07cf3e4b6a907840aface36ae5ee67ca8979), [`a894fe1`](https://github.com/Effect-TS/effect/commit/a894fe1df8974077293d9c1b924a7f80fc7fe7f1), [`d10ceb0`](https://github.com/Effect-TS/effect/commit/d10ceb06d56108c11100868f591d2b42ddff5e9f), [`7e9923b`](https://github.com/Effect-TS/effect/commit/7e9923b1a0adf1f842216b298d7542bed980c9a5), [`f064121`](https://github.com/Effect-TS/effect/commit/f0641210f960563f813ac6f728804e5447c03341), [`d10ceb0`](https://github.com/Effect-TS/effect/commit/d10ceb06d56108c11100868f591d2b42ddff5e9f), [`b660bf0`](https://github.com/Effect-TS/effect/commit/b660bf01d9c427552296cd9e0195e21504f45e1f), [`f4fbe9c`](https://github.com/Effect-TS/effect/commit/f4fbe9ca0209cdfaaaff54fc3805221be80f1ffa), [`d10ceb0`](https://github.com/Effect-TS/effect/commit/d10ceb06d56108c11100868f591d2b42ddff5e9f), [`e811353`](https://github.com/Effect-TS/effect/commit/e811353e3b79ba392af1d9fb8d7f93fd729dabf9), [`9761c3c`](https://github.com/Effect-TS/effect/commit/9761c3c4787b3815346c1b650d8984efec8f1051), [`baa99fc`](https://github.com/Effect-TS/effect/commit/baa99fc176efed4986c19c78726d1dbe7bd17765), [`7fd79b2`](https://github.com/Effect-TS/effect/commit/7fd79b2cc95973f85b3db43b0cf3c5cb7d2f69c4), [`a82ffc0`](https://github.com/Effect-TS/effect/commit/a82ffc03df0fb34e02f16773b96bfa3e0208e427), [`d10ceb0`](https://github.com/Effect-TS/effect/commit/d10ceb06d56108c11100868f591d2b42ddff5e9f), [`4026e2d`](https://github.com/Effect-TS/effect/commit/4026e2dde3b098e70ffb3f1fcddd200176acdefd), [`397bf1e`](https://github.com/Effect-TS/effect/commit/397bf1ebd95c0d6d58dc53e4f33c8ad3f34746f6), [`d10ceb0`](https://github.com/Effect-TS/effect/commit/d10ceb06d56108c11100868f591d2b42ddff5e9f), [`d10ceb0`](https://github.com/Effect-TS/effect/commit/d10ceb06d56108c11100868f591d2b42ddff5e9f)]:
  - effect@4.0.0-rc.110

## 4.0.0-rc.109

### Patch Changes

- [#7208](https://github.com/Effect-TS/effect/pull/7208) [`0303139`](https://github.com/Effect-TS/effect/commit/03031395d3ddee197217f826e7d9ef68b0674823) Thanks @moishinetzer! - Default new Anthropic models to modern capabilities while preserving the limits of legacy Claude models.
  
  Unknown models now default to native structured outputs and 128K output tokens, so future model releases do not require capability-table updates. Use the new `structuredOutputs` model config option to override capability detection when needed.
- Updated dependencies [[`a0743f2`](https://github.com/Effect-TS/effect/commit/a0743f2b9f20fb5d150f35510e68819f01630bac), [`17892e7`](https://github.com/Effect-TS/effect/commit/17892e75a8d584f79127805506c42b19320990a7), [`4d8a230`](https://github.com/Effect-TS/effect/commit/4d8a2306dfff8fd5406ab75d0c8d22e5300d1faa), [`f21f9c9`](https://github.com/Effect-TS/effect/commit/f21f9c9f73dc59db922bda411b6d5245dae37cdb), [`18270dd`](https://github.com/Effect-TS/effect/commit/18270ddeaf4ad28723ca8a40aff04a5d4707b575), [`26db404`](https://github.com/Effect-TS/effect/commit/26db404a3284cfdbf4a3f351ccd05afc0de743b8), [`2670398`](https://github.com/Effect-TS/effect/commit/26703982612e12954360382e4b1d177002699d1c), [`3702bed`](https://github.com/Effect-TS/effect/commit/3702bedd8f6bcb3f603b87c640c521878d824eb3), [`ccae60e`](https://github.com/Effect-TS/effect/commit/ccae60e5edb2bef553f4af52afb509dfd443cd03), [`6ff5396`](https://github.com/Effect-TS/effect/commit/6ff53968138bbd7d4728ce8014e35eae8d6ca5d0)]:
  - effect@4.0.0-rc.109

## 4.0.0-rc.108

### Patch Changes

- Updated dependencies [[`dfb173e`](https://github.com/Effect-TS/effect/commit/dfb173efffd20c4feded4efe409018dd55acdca8), [`005e090`](https://github.com/Effect-TS/effect/commit/005e0902cace9f8960a4f43573665a3a9b53b6fa), [`c82c532`](https://github.com/Effect-TS/effect/commit/c82c53228dc1c50cc99654ce6de7766b4de09e75), [`22b579f`](https://github.com/Effect-TS/effect/commit/22b579f6c582e6e2d951784791fea6f1802517ed), [`3e19539`](https://github.com/Effect-TS/effect/commit/3e19539205082b1006d84553045d1b03db9cc8a1), [`08a3c74`](https://github.com/Effect-TS/effect/commit/08a3c74133206fc1cc728e0aa96d02e672fd80bd), [`eb0bae0`](https://github.com/Effect-TS/effect/commit/eb0bae08d543d58754c9bb7a57e67c1e2bb3f55a), [`97b544d`](https://github.com/Effect-TS/effect/commit/97b544d8b636587647b90691d669305c0eb4fc66), [`4f6d131`](https://github.com/Effect-TS/effect/commit/4f6d131e85d74ab0ec0300e52e503a5f943fc576), [`fad4b7c`](https://github.com/Effect-TS/effect/commit/fad4b7c5138b3f38c2427436da2e0685c1ca4e9b), [`accf447`](https://github.com/Effect-TS/effect/commit/accf4474513064e2a21d14b1937503261b4f34dc), [`31b27e4`](https://github.com/Effect-TS/effect/commit/31b27e49903c351588435f666c953aaac28f6120), [`8458951`](https://github.com/Effect-TS/effect/commit/84589518c3966c63d7f3679a5296d380eb1ba887)]:
  - effect@4.0.0-rc.108

## 4.0.0-beta.107

### Patch Changes

- Updated dependencies [[`596f3f9`](https://github.com/Effect-TS/effect/commit/596f3f92d7fe355811b815cb212332b082268ce8), [`9611ed4`](https://github.com/Effect-TS/effect/commit/9611ed42d11300546b339ab13492a0f7bdb1ebfb), [`8b91605`](https://github.com/Effect-TS/effect/commit/8b9160548556e4b0ec7ee2f2707716776be49018), [`d901928`](https://github.com/Effect-TS/effect/commit/d901928efa44f573ed1247f53fdb203a8e4fcede), [`b32bdef`](https://github.com/Effect-TS/effect/commit/b32bdef0d119a1ad1463dc01a46763ffee1f9bd9)]:
  - effect@4.0.0-beta.107

## 4.0.0-beta.106

### Patch Changes

- [#7129](https://github.com/Effect-TS/effect/pull/7129) [`d0baed9`](https://github.com/Effect-TS/effect/commit/d0baed9d72c5191d5ab3945ffe464b9515d0ac53) Thanks @mkdynamic! - Correct the maximum output tokens for Claude Opus 4.6, 4.7, 4.8 and Sonnet 4.6.
  
  These models were grouped with the 4.5 family at 64000 output tokens, half of the 128000 the API actually allows, so requests defaulted to a cap far below the model's real limit. The 4.5 models keep 64000, which is correct for them.
- Updated dependencies [[`2695168`](https://github.com/Effect-TS/effect/commit/269516851b24916d72771f8a554b88722e3732e7), [`6310a8c`](https://github.com/Effect-TS/effect/commit/6310a8c68c74dcf1d23948ec9243ac5f407a1651), [`c2071b1`](https://github.com/Effect-TS/effect/commit/c2071b1647e2326568c1d0689274ef62b8a7183f), [`7aff81a`](https://github.com/Effect-TS/effect/commit/7aff81a9cefe681483ef8abf717d786fd10e7e8d), [`a1d4057`](https://github.com/Effect-TS/effect/commit/a1d4057711935a544ef441bc2d0ac3565dfa9266), [`abf77b0`](https://github.com/Effect-TS/effect/commit/abf77b04009dcb4d67a258f9d8ada778e9f4ffae), [`6c60375`](https://github.com/Effect-TS/effect/commit/6c60375e68683a32d54554150cc493e16550a06d), [`22f4897`](https://github.com/Effect-TS/effect/commit/22f4897bbae24783d4516f6bef353f1db4ec6d03), [`615d1d5`](https://github.com/Effect-TS/effect/commit/615d1d5d0256ec8160f2e08d0dcf5dc83acb7bf1), [`3a86757`](https://github.com/Effect-TS/effect/commit/3a867573ddeed5888dabdeb3225a9ebbf00491e7), [`f4a9762`](https://github.com/Effect-TS/effect/commit/f4a9762bb9dfad59c215f2e099dcc829d74f4ed1), [`0bcf6ed`](https://github.com/Effect-TS/effect/commit/0bcf6ed57c22e8a36964726b15464101d90f5997), [`ba9cb63`](https://github.com/Effect-TS/effect/commit/ba9cb63b87d45ce2df872dd8ef0905da147cc675), [`42c810d`](https://github.com/Effect-TS/effect/commit/42c810dd372275b822dd99c7d7e774e153f0a752), [`1416ccd`](https://github.com/Effect-TS/effect/commit/1416ccd474bc9da8979f51b72b5e53fb3ac56edf), [`08d0d39`](https://github.com/Effect-TS/effect/commit/08d0d39a225deccb9db213ab5fcf55edb9f9ba5d), [`548908a`](https://github.com/Effect-TS/effect/commit/548908a71d9337cb7defe7fc93b2fba8f6a04b6f), [`4b3460d`](https://github.com/Effect-TS/effect/commit/4b3460daa434ec465a95a50704fe1103a9275999), [`d170596`](https://github.com/Effect-TS/effect/commit/d17059615cca37ca2776654078fe0501ac5202e6), [`aea89d0`](https://github.com/Effect-TS/effect/commit/aea89d0c42ee0ac707a4962cd348fd3158cb469b), [`deed5fb`](https://github.com/Effect-TS/effect/commit/deed5fbdc91cf8bf8c5fce7dfa5d6527ac944726)]:
  - effect@4.0.0-beta.106

## 4.0.0-beta.105

### Patch Changes

- Updated dependencies [[`0418564`](https://github.com/Effect-TS/effect/commit/04185644dabb8e4169f1ef6cbbc0b36c4db2f7f4), [`d334a85`](https://github.com/Effect-TS/effect/commit/d334a8593aafcd60753995a9449b654c67bfdcc1), [`f0be855`](https://github.com/Effect-TS/effect/commit/f0be8554da6ee00293a6b23869ac46a0b0d97dc8), [`b206fa5`](https://github.com/Effect-TS/effect/commit/b206fa5d7655c1634c9993410a9203f6616a5ca2), [`b938c8a`](https://github.com/Effect-TS/effect/commit/b938c8ad2823bd88493187922f7d9090eff037b6), [`8525f05`](https://github.com/Effect-TS/effect/commit/8525f05d1e14ea12298e9e1a0df497bfaac2ce9a)]:
  - effect@4.0.0-beta.105

## 4.0.0-beta.104

### Patch Changes

- [#7070](https://github.com/Effect-TS/effect/pull/7070) [`a5404d4`](https://github.com/Effect-TS/effect/commit/a5404d4f4361350b6ecbb1a2f601365852141f60) Thanks @fubhy! - Decode byte-backed plain-text attachments as UTF-8 text in Anthropic requests.
- Updated dependencies [[`1001bcc`](https://github.com/Effect-TS/effect/commit/1001bccb9e874918d59dbb36860f1c5d4499ac20), [`993ba60`](https://github.com/Effect-TS/effect/commit/993ba60ee6c7ca6eb84522040f8b0d268b6ba7d4), [`67faacd`](https://github.com/Effect-TS/effect/commit/67faacd4679242559bee31717c05a5b10b990322), [`b78acdf`](https://github.com/Effect-TS/effect/commit/b78acdf422568f10ae8684fd3f10d52b065f0b56), [`fbb9ce5`](https://github.com/Effect-TS/effect/commit/fbb9ce5e625d1a7d6b7005bda42cbb6cd31476c5), [`722ea48`](https://github.com/Effect-TS/effect/commit/722ea484c9d01364c9242d929c0a564f7831a57c), [`3058fd5`](https://github.com/Effect-TS/effect/commit/3058fd594f5a683034212d71d957017fcc084006), [`62d0575`](https://github.com/Effect-TS/effect/commit/62d057566c241405c23ecf0bf4156186bd2be924), [`99dd6b5`](https://github.com/Effect-TS/effect/commit/99dd6b580434f97c5b40adc919f429e4abc3dfe7), [`7963ce1`](https://github.com/Effect-TS/effect/commit/7963ce1cd95f037fbefea67a29ead49cce4d16cb), [`af14e75`](https://github.com/Effect-TS/effect/commit/af14e752edd65e2b652e960411afafc88975a8d8), [`24e22d2`](https://github.com/Effect-TS/effect/commit/24e22d23a73a2e93ebf6d8edd2246a4a406942c8), [`647d14e`](https://github.com/Effect-TS/effect/commit/647d14e572c8004fa92fba256e00552b42bf34b7), [`1434eec`](https://github.com/Effect-TS/effect/commit/1434eecbd368e00839c24b3950f0b7a69218669a), [`a5278b1`](https://github.com/Effect-TS/effect/commit/a5278b18242011d1b2b08304c7c128151f9a4370), [`6af04a5`](https://github.com/Effect-TS/effect/commit/6af04a50bd019238f6acdb9cbda40439a3c09210), [`cb6c837`](https://github.com/Effect-TS/effect/commit/cb6c8376b2f322d4e7cbfc0973fc3b4f2951ee6e), [`d44cead`](https://github.com/Effect-TS/effect/commit/d44cead7e0e0ce61f0d980906e494f49a07e7899), [`88c7632`](https://github.com/Effect-TS/effect/commit/88c7632c2b59a49fcc40d250865bd8d0dccf31b0), [`abcbb2a`](https://github.com/Effect-TS/effect/commit/abcbb2abe16f1b6c587c15007df14371e1e70e93), [`8f63cce`](https://github.com/Effect-TS/effect/commit/8f63cce636700fde26b140b82e350ef916989d86), [`d56dfcf`](https://github.com/Effect-TS/effect/commit/d56dfcf54c2b9c53c3d098ce4b0ffcc84496c5f7), [`a98cda9`](https://github.com/Effect-TS/effect/commit/a98cda9422e1352f22e81696f759f326ffcfb667), [`6704bb8`](https://github.com/Effect-TS/effect/commit/6704bb84c320547f83cf50e8586ffc4c5e4c3cc5), [`6143de2`](https://github.com/Effect-TS/effect/commit/6143de21ee22038b45a8d4eba86f5aade6238eba), [`936b135`](https://github.com/Effect-TS/effect/commit/936b1358396eb0a1a7c8e0878ba63297e2106812), [`1bbae84`](https://github.com/Effect-TS/effect/commit/1bbae84f88b577a26d04ceb2e76d3143d09c4a20), [`d795ee7`](https://github.com/Effect-TS/effect/commit/d795ee771701ea62bd187ef7c0307d9737f68c1a), [`0a82d88`](https://github.com/Effect-TS/effect/commit/0a82d88b7da73278b6f270118e396d5ed4a64747), [`9215bc5`](https://github.com/Effect-TS/effect/commit/9215bc5da7dd10aa45f07fe44b98f06b6e433d62), [`a1b5df2`](https://github.com/Effect-TS/effect/commit/a1b5df2064d92431cfc6e638af613cc3114313d7), [`92a9ac5`](https://github.com/Effect-TS/effect/commit/92a9ac5ac0aa63d8975b9ba7a094d6a8f59a98f2), [`6bde7f2`](https://github.com/Effect-TS/effect/commit/6bde7f27f3243427203e53fe74472990e5c2a349), [`a712131`](https://github.com/Effect-TS/effect/commit/a7121310dbb60cbd819bbd702f97663098ec7bb8), [`2e6f760`](https://github.com/Effect-TS/effect/commit/2e6f760dcb44e2b984f3311a8af03a1d68a2ec7e), [`aa05804`](https://github.com/Effect-TS/effect/commit/aa0580497e027ed30b756058db0067c3fe07664f), [`badd3bf`](https://github.com/Effect-TS/effect/commit/badd3bf65fac4dd1e66e1f602db43659722dfced), [`02b0265`](https://github.com/Effect-TS/effect/commit/02b02651ede46a5a2dd3ef8081d0ad89648d0cbf), [`3437e21`](https://github.com/Effect-TS/effect/commit/3437e21a56d805781c5e5946a6189795a1dfd411), [`41a550d`](https://github.com/Effect-TS/effect/commit/41a550d1fed31e829929a8f5362b5340303164ac), [`17b5d50`](https://github.com/Effect-TS/effect/commit/17b5d50219ad49533cf9e33d01924a3e16af5eb3), [`96e5e95`](https://github.com/Effect-TS/effect/commit/96e5e9576b0315c747462761a61940ff9fe32dd1), [`e4d589e`](https://github.com/Effect-TS/effect/commit/e4d589e0ea08dc57c4793053b395dc0fcc499f34), [`ae4cf7b`](https://github.com/Effect-TS/effect/commit/ae4cf7b5e2cb5f8c55657e31a61789ad21c38c18), [`6ef5f1a`](https://github.com/Effect-TS/effect/commit/6ef5f1a041f3a40bf03fadd0b1feb275c277c635), [`2235a29`](https://github.com/Effect-TS/effect/commit/2235a29502c3f33cf6468511ad931089013a7916), [`b32f4cb`](https://github.com/Effect-TS/effect/commit/b32f4cb7b2d8ebe817075322622498e3beb05336), [`7f4c095`](https://github.com/Effect-TS/effect/commit/7f4c095b62da43780dd7fc2a5d1785ddfce60edf), [`5f3fb81`](https://github.com/Effect-TS/effect/commit/5f3fb814d18d8a54946c1c1cd0b41459cdb24006), [`17f0b91`](https://github.com/Effect-TS/effect/commit/17f0b91a243ccfe4a38d27debdc983adf434e738), [`0cdadd7`](https://github.com/Effect-TS/effect/commit/0cdadd75bc8abbbcad7956a4bc71f4e7a9b13250), [`39b57d7`](https://github.com/Effect-TS/effect/commit/39b57d7857358040558b67dd33eafc7bb5457830), [`5a6a573`](https://github.com/Effect-TS/effect/commit/5a6a5738e5bfc39e3a37ae7ba99081601fa19ac3), [`59f5e99`](https://github.com/Effect-TS/effect/commit/59f5e9981913b92d7a9beb2214a21d658b999d3a), [`45379d6`](https://github.com/Effect-TS/effect/commit/45379d6179ee4df2cbd3f848bd39ff7149c24a38), [`1949439`](https://github.com/Effect-TS/effect/commit/1949439175809ef81ab9c6411ed5559109edb4c9), [`e443403`](https://github.com/Effect-TS/effect/commit/e443403cf0e4effea14bb6cd950c5ac1c86cc748), [`03af7e8`](https://github.com/Effect-TS/effect/commit/03af7e85551204c605ea2fa2c43c10a4538ac8fb), [`0f721d4`](https://github.com/Effect-TS/effect/commit/0f721d406df8703ea92ca28777b3f09599e2056d), [`130b28d`](https://github.com/Effect-TS/effect/commit/130b28df552d7053407b041a96ff09dae82575e5), [`c987a12`](https://github.com/Effect-TS/effect/commit/c987a12a01b6a52ad53d29edf02613b03574dbcc), [`4158562`](https://github.com/Effect-TS/effect/commit/41585620977de9b84171f76619b72e29cc2284e5), [`306014a`](https://github.com/Effect-TS/effect/commit/306014a1ce4d5cb956c76bdc20e4e28ab3e61a6a), [`729a663`](https://github.com/Effect-TS/effect/commit/729a663275dd31f2357c446fe69664429220a83d), [`caf84b6`](https://github.com/Effect-TS/effect/commit/caf84b660044089e8d7f4067b279b27b8b50e8fd), [`ce067f7`](https://github.com/Effect-TS/effect/commit/ce067f799ea27735d4194345298a216aaf429f01), [`7a41f5a`](https://github.com/Effect-TS/effect/commit/7a41f5aa72d540ecf2746992ecc3fa3e6b40d31f), [`781022a`](https://github.com/Effect-TS/effect/commit/781022acdd3537ca18c88e2fa3681bafa6ef1b21), [`39f1297`](https://github.com/Effect-TS/effect/commit/39f1297acc08864feb12de6b8cf2bf73434f6cf5), [`2db266b`](https://github.com/Effect-TS/effect/commit/2db266b1bfbc81868bc1778c37c76032a267c79f), [`2141e28`](https://github.com/Effect-TS/effect/commit/2141e28903754d72604acf81673ceb2c62a56646), [`3c5e429`](https://github.com/Effect-TS/effect/commit/3c5e429878669ffcf5e0da4ddfbf50bde5bbcaad), [`20ddc63`](https://github.com/Effect-TS/effect/commit/20ddc630584f8fe488162ba384adcae53fc6810a), [`841b3ea`](https://github.com/Effect-TS/effect/commit/841b3ea6ae19a784bc1c20497b02f632af0c91e9), [`82a3fbf`](https://github.com/Effect-TS/effect/commit/82a3fbfce8b9df33e587076b7d7168ecd6799e17), [`eb9ee83`](https://github.com/Effect-TS/effect/commit/eb9ee83b38844a71d1cd5653a229309cfcb04a36), [`64dc7c7`](https://github.com/Effect-TS/effect/commit/64dc7c76dc5c89887b9e7c181d1873dcbb7820d1), [`84dc8ab`](https://github.com/Effect-TS/effect/commit/84dc8ab7accc682bc668c78a97e4a1776b633be8), [`b4463f4`](https://github.com/Effect-TS/effect/commit/b4463f46fc33d3b01ea5eadd7d012a5abda347a3), [`592dd36`](https://github.com/Effect-TS/effect/commit/592dd361645739ac0cd8e6babb084cd27403c172), [`85d2b44`](https://github.com/Effect-TS/effect/commit/85d2b446e3059de4919be730105868f79728308d), [`32e4a69`](https://github.com/Effect-TS/effect/commit/32e4a69b3151b7ec4058af2213b96a41d11e9e06), [`13c5872`](https://github.com/Effect-TS/effect/commit/13c5872ed30830360367ad89af2dab68a003c351), [`3454cdb`](https://github.com/Effect-TS/effect/commit/3454cdb528fdb5d3ed0c5c5c8169bc47de41fbd8), [`e930804`](https://github.com/Effect-TS/effect/commit/e9308045be1d8a00c0b4046f1e8ff22cf68c93da), [`7f12d4b`](https://github.com/Effect-TS/effect/commit/7f12d4b4e731dc3a213ae5c3f60db9edc50292d2), [`181c9ef`](https://github.com/Effect-TS/effect/commit/181c9ef5e5d4ab247bf4aec06424f15b0a1e802e), [`dd9f891`](https://github.com/Effect-TS/effect/commit/dd9f891e23f316abb6192893008f0e33ece9d97d), [`433fb81`](https://github.com/Effect-TS/effect/commit/433fb81ca4c15c681a8ae097ce3ff9bd3a9c9aa5), [`8459cdb`](https://github.com/Effect-TS/effect/commit/8459cdbae8a476dc04b6247fffe6a1668dcb1217), [`6124ab3`](https://github.com/Effect-TS/effect/commit/6124ab39eb64688fbd5d688d24766542f9cb5a2c), [`01bd954`](https://github.com/Effect-TS/effect/commit/01bd9546f142706fca1628f7261e6d1cb9638948), [`ba2c3aa`](https://github.com/Effect-TS/effect/commit/ba2c3aa05eb87ec05d263b960017ecf29746f66a), [`0a45ef3`](https://github.com/Effect-TS/effect/commit/0a45ef3bb4a1ae9b345c43c548db4336a31b3191), [`8459cdb`](https://github.com/Effect-TS/effect/commit/8459cdbae8a476dc04b6247fffe6a1668dcb1217), [`eaa7e71`](https://github.com/Effect-TS/effect/commit/eaa7e71b88bf59b24610128c6115a2a126432731), [`db4c2cc`](https://github.com/Effect-TS/effect/commit/db4c2ccdec77d813b6f4cc72a302ee7c4fe6e39d), [`22f150a`](https://github.com/Effect-TS/effect/commit/22f150a0936cef30517e87eaca73bff1c5e4873a), [`90ffb08`](https://github.com/Effect-TS/effect/commit/90ffb083b3091c211300f50a42ba7bf56536c0ee), [`d517692`](https://github.com/Effect-TS/effect/commit/d517692ef75f45d5f6d9d68b32d41fa0ccc56c99), [`01af079`](https://github.com/Effect-TS/effect/commit/01af079c189d1fc5067d3b1933b2870c4baf2693), [`32a59e8`](https://github.com/Effect-TS/effect/commit/32a59e8058b1ec9738cb083cf1cb116b393ca114)]:
  - effect@4.0.0-beta.104

## 4.0.0-beta.103

### Patch Changes

- [#6777](https://github.com/Effect-TS/effect/pull/6777) [`8e7c706`](https://github.com/Effect-TS/effect/commit/8e7c706b0aca855489b53d987404566d3e9cb5e7) Thanks @tim-smart! - Bound pending SSE decoder state with a configurable maximum event size.

- [#6918](https://github.com/Effect-TS/effect/pull/6918) [`a913136`](https://github.com/Effect-TS/effect/commit/a9131368c1347ad4c409c9df80245d765e96a4fe) Thanks @fubhy! - Fix malformed JSON in streamed Anthropic code-execution tool parameters.

- [#6701](https://github.com/Effect-TS/effect/pull/6701) [`9867b9f`](https://github.com/Effect-TS/effect/commit/9867b9fc69f9cc6c443594fc7eccc7be0c674d9c) Thanks @fubhy! - Removed explicit ./index entrypoints

- Updated dependencies [[`e56cd8f`](https://github.com/Effect-TS/effect/commit/e56cd8f90c3559baccf8fcf2852ea911235d5944), [`f77c120`](https://github.com/Effect-TS/effect/commit/f77c120d8e04779ddeb8bce8e9cde932f268e4b6), [`b2f95a9`](https://github.com/Effect-TS/effect/commit/b2f95a9c2f2581deb89dc3bae9e89cf819e82923), [`04fd44a`](https://github.com/Effect-TS/effect/commit/04fd44a42abfa8dc2642300dcf49ee48c8ef4539), [`b74333d`](https://github.com/Effect-TS/effect/commit/b74333d83e15b9d042e4698ad23040de60454afe), [`1c40b28`](https://github.com/Effect-TS/effect/commit/1c40b2809503d6aa1358777196fc66317906e657), [`aeba0c8`](https://github.com/Effect-TS/effect/commit/aeba0c8c9ffc5f125d961ae21e4ac15491e51046), [`b3901d2`](https://github.com/Effect-TS/effect/commit/b3901d29c543fd5bd05ceec669a17896c8e19006), [`4a0984a`](https://github.com/Effect-TS/effect/commit/4a0984af62738fedf4bd3e87adb4d4d641ce9147), [`fffd88b`](https://github.com/Effect-TS/effect/commit/fffd88b3135abdf928ca7c4b0e00e610985091c7), [`f3f6c1e`](https://github.com/Effect-TS/effect/commit/f3f6c1e02cb543423fcffef5dc2db03fac503588), [`ef07642`](https://github.com/Effect-TS/effect/commit/ef07642dfe671d5258b65d1c1480c4d05c495f15), [`f1bc827`](https://github.com/Effect-TS/effect/commit/f1bc8274a608813d7b09d28dcca04adbf62f8c92), [`aeba0c8`](https://github.com/Effect-TS/effect/commit/aeba0c8c9ffc5f125d961ae21e4ac15491e51046), [`081f4d8`](https://github.com/Effect-TS/effect/commit/081f4d8cd06a2ac222d2810b46e61efcee26939e), [`5287b24`](https://github.com/Effect-TS/effect/commit/5287b24f5f8fa094ba20e117bfb1a80fba6d2cf5), [`13d31cf`](https://github.com/Effect-TS/effect/commit/13d31cfc2dde46210e94391b5b6767ae9aeaf2c9), [`acee269`](https://github.com/Effect-TS/effect/commit/acee26944bc89ee554d7b9fadab7443f9edc28a9), [`31170c1`](https://github.com/Effect-TS/effect/commit/31170c19b236c37abb5476c821bc6f5bfa2735ab), [`205ebc7`](https://github.com/Effect-TS/effect/commit/205ebc776062012581e98fced7ced19adfc44ee7), [`ed0ebf8`](https://github.com/Effect-TS/effect/commit/ed0ebf8e5c864d46fed1f232e99c0e680f10a58f), [`a3fd084`](https://github.com/Effect-TS/effect/commit/a3fd08482157bd78b089f77c7b173d54ef68b5cd), [`ee29ddf`](https://github.com/Effect-TS/effect/commit/ee29ddf862c3723ad466abc93ab6f6fe723b2319), [`6086309`](https://github.com/Effect-TS/effect/commit/60863090af8e5af0bfa1435f08dc5390f9993e30), [`4a57af2`](https://github.com/Effect-TS/effect/commit/4a57af24011db1d66e947289d2f7ffc2074696d2), [`660875b`](https://github.com/Effect-TS/effect/commit/660875b4325e6eebb3f04513998301cd2a0847ec), [`8e7c706`](https://github.com/Effect-TS/effect/commit/8e7c706b0aca855489b53d987404566d3e9cb5e7), [`5f63adb`](https://github.com/Effect-TS/effect/commit/5f63adbe75fc9d50d23706a52b3e483ad2a1a01c), [`053bc42`](https://github.com/Effect-TS/effect/commit/053bc42e2a964755611a216e78ed214322efee37), [`c0a1534`](https://github.com/Effect-TS/effect/commit/c0a153494484ecf9f0d0f20895a7a648b4be363b), [`f1e3a37`](https://github.com/Effect-TS/effect/commit/f1e3a378c144f974a6122b299f421b75595af20f), [`cedb01a`](https://github.com/Effect-TS/effect/commit/cedb01a025492a1faf9e59eb23eb96bc3b5e2fff), [`1747440`](https://github.com/Effect-TS/effect/commit/1747440de9a51a56ed3660da748cc01b256adce7), [`aeba0c8`](https://github.com/Effect-TS/effect/commit/aeba0c8c9ffc5f125d961ae21e4ac15491e51046), [`aeba0c8`](https://github.com/Effect-TS/effect/commit/aeba0c8c9ffc5f125d961ae21e4ac15491e51046), [`b4f1ee2`](https://github.com/Effect-TS/effect/commit/b4f1ee238d96aa78c5f040158cb78671d75b381e), [`a4757f1`](https://github.com/Effect-TS/effect/commit/a4757f1c47067d8d016a6c4a2c541bb8ae520f9b), [`cd122b9`](https://github.com/Effect-TS/effect/commit/cd122b90300d995a237993a2edb7a049785ab6a4), [`5de588b`](https://github.com/Effect-TS/effect/commit/5de588b2472fb0f4eb919766eb8472583a044772), [`3895b9c`](https://github.com/Effect-TS/effect/commit/3895b9cf179262cd277a9c6daafe9050dcf8265e), [`89ce5f3`](https://github.com/Effect-TS/effect/commit/89ce5f3e16e23a193daa475dc72ea8133ae1dacd), [`985de09`](https://github.com/Effect-TS/effect/commit/985de097d75906db2aed784841f81e23cc978b43), [`9800e3a`](https://github.com/Effect-TS/effect/commit/9800e3acc8f36530f671bc8b91558cb112f449a7), [`4dc35f6`](https://github.com/Effect-TS/effect/commit/4dc35f64641746366f867ea3dbfedb9cd4685ada), [`e8eb62b`](https://github.com/Effect-TS/effect/commit/e8eb62b3d0ef27e9761cdc2eb93bdec52d6ee204), [`ecd9993`](https://github.com/Effect-TS/effect/commit/ecd99936112cb69efdb02de3a2fd57f47baefdf3), [`5ab9c08`](https://github.com/Effect-TS/effect/commit/5ab9c08463ce049c45f3502676954a7b72c6b024), [`f5cf965`](https://github.com/Effect-TS/effect/commit/f5cf96548afd51f4b3cf1aea11b04d7f8549ce90), [`a94cbed`](https://github.com/Effect-TS/effect/commit/a94cbed84e9e49bea4bff925599c0f19c4e3deab), [`9160ad7`](https://github.com/Effect-TS/effect/commit/9160ad7d146d4376dd12f7510c025e5b2f638a70), [`aeba0c8`](https://github.com/Effect-TS/effect/commit/aeba0c8c9ffc5f125d961ae21e4ac15491e51046), [`aeba0c8`](https://github.com/Effect-TS/effect/commit/aeba0c8c9ffc5f125d961ae21e4ac15491e51046), [`52494be`](https://github.com/Effect-TS/effect/commit/52494be9e8eb3bb542d06a3dfefc6bca4e168984), [`5441c8e`](https://github.com/Effect-TS/effect/commit/5441c8e656a6418c0d27feb2df67565a3e1155f4), [`c9b56ab`](https://github.com/Effect-TS/effect/commit/c9b56ab507f224426ee8388dc450da447ec4715f), [`8ef7257`](https://github.com/Effect-TS/effect/commit/8ef72577d1f43212cab87951d659e54e3c8d7d91), [`1519406`](https://github.com/Effect-TS/effect/commit/1519406fed6e8b017ae178dc20bcaa2cf318b570), [`9716990`](https://github.com/Effect-TS/effect/commit/97169902eec3c99baa7f0b2c7b45a0a5eae75819), [`733f75b`](https://github.com/Effect-TS/effect/commit/733f75b7125e3016a975fdd251c0179ae5393786), [`48155c8`](https://github.com/Effect-TS/effect/commit/48155c8ccfc12dcca8a00fa358d50b20c30874e4), [`951d06b`](https://github.com/Effect-TS/effect/commit/951d06b83d459d3e8fa9024e727a5db1662d3322), [`d767b65`](https://github.com/Effect-TS/effect/commit/d767b65a7687e38be23f0b0ee3d52ab5f2360cbe), [`5d52d9d`](https://github.com/Effect-TS/effect/commit/5d52d9d148aaa7f736ed8c310fc8bfa9dc81badf), [`f4151e1`](https://github.com/Effect-TS/effect/commit/f4151e1937c26de14f1d64566f8126173f1b5014), [`e02fbb6`](https://github.com/Effect-TS/effect/commit/e02fbb66f5a0f13dba6c33ef63528a37a17a0676), [`724ce09`](https://github.com/Effect-TS/effect/commit/724ce09650a458d4565e5c7331ea92ca04f08e68), [`dbe91f6`](https://github.com/Effect-TS/effect/commit/dbe91f6961ef9f7e8da910ee5758d9c0d385fca8), [`4c008d2`](https://github.com/Effect-TS/effect/commit/4c008d28b370d817f7ae4579db09836fe084c8d2), [`b650832`](https://github.com/Effect-TS/effect/commit/b6508328708a842f3163467b72486bd228f1a289), [`b46c92f`](https://github.com/Effect-TS/effect/commit/b46c92f3b314f4ffd612b831efa55dd856c587a3), [`5335797`](https://github.com/Effect-TS/effect/commit/5335797003076d9c6fd170da98d779696d555596), [`4b3460d`](https://github.com/Effect-TS/effect/commit/4b3460daa434ec465a95a50704fe1103a9275999), [`6301fd7`](https://github.com/Effect-TS/effect/commit/6301fd710b4325718de2c42997dac28a9e9aa250), [`aebc5c6`](https://github.com/Effect-TS/effect/commit/aebc5c61664b89a840465ec65b79ce635a5ceee8), [`52b2d7b`](https://github.com/Effect-TS/effect/commit/52b2d7b5bd3c7cce3bd5b69c6ab3941004da70f3), [`eec5744`](https://github.com/Effect-TS/effect/commit/eec57445dfa0ef3c5977195ad69415b7e7d42bb6), [`24e0e93`](https://github.com/Effect-TS/effect/commit/24e0e93dc307dc2c2ae86caacb7289e1dab3c103), [`aeba0c8`](https://github.com/Effect-TS/effect/commit/aeba0c8c9ffc5f125d961ae21e4ac15491e51046), [`aeba0c8`](https://github.com/Effect-TS/effect/commit/aeba0c8c9ffc5f125d961ae21e4ac15491e51046), [`aeba0c8`](https://github.com/Effect-TS/effect/commit/aeba0c8c9ffc5f125d961ae21e4ac15491e51046), [`1a7ce81`](https://github.com/Effect-TS/effect/commit/1a7ce8150e3977586c44d8ccb9a8384389bb4d49), [`48f22a7`](https://github.com/Effect-TS/effect/commit/48f22a7d16ae57ee2175d450dafbdeb69e187d2a), [`c96b7f6`](https://github.com/Effect-TS/effect/commit/c96b7f6359662053c3e09344f61dddc7a6caf4ac), [`6d2a942`](https://github.com/Effect-TS/effect/commit/6d2a942ed7cd33b8fd79d549edba33bc9e2a7e3e), [`cc27b19`](https://github.com/Effect-TS/effect/commit/cc27b194b9d13fa3a66ab037e853fca9d41700ff), [`8f9499f`](https://github.com/Effect-TS/effect/commit/8f9499f562729f5f7b08d8bcc4db86b4aeff8a21), [`3eeea73`](https://github.com/Effect-TS/effect/commit/3eeea73cfc3e9b126975c2ddbdb7f7c8c92026e2), [`0a532e5`](https://github.com/Effect-TS/effect/commit/0a532e503f165fdea485a5343fc2f420917e8376), [`f398149`](https://github.com/Effect-TS/effect/commit/f398149c134fd9b67b6cdc52eae3f3248d5c7bbe), [`aeba0c8`](https://github.com/Effect-TS/effect/commit/aeba0c8c9ffc5f125d961ae21e4ac15491e51046), [`ace903e`](https://github.com/Effect-TS/effect/commit/ace903e09c2549ceebdec380797beb027cd29f3d), [`e8eb62b`](https://github.com/Effect-TS/effect/commit/e8eb62b3d0ef27e9761cdc2eb93bdec52d6ee204), [`aeba0c8`](https://github.com/Effect-TS/effect/commit/aeba0c8c9ffc5f125d961ae21e4ac15491e51046), [`48f22a7`](https://github.com/Effect-TS/effect/commit/48f22a7d16ae57ee2175d450dafbdeb69e187d2a), [`d48506d`](https://github.com/Effect-TS/effect/commit/d48506d97525040aa714305e928126df799795b4), [`aeba0c8`](https://github.com/Effect-TS/effect/commit/aeba0c8c9ffc5f125d961ae21e4ac15491e51046), [`d48506d`](https://github.com/Effect-TS/effect/commit/d48506d97525040aa714305e928126df799795b4), [`d48506d`](https://github.com/Effect-TS/effect/commit/d48506d97525040aa714305e928126df799795b4), [`52262be`](https://github.com/Effect-TS/effect/commit/52262be2edce0e350c6ac10f8f725678606399c5), [`1284aa1`](https://github.com/Effect-TS/effect/commit/1284aa183451955ad7921bbe01fd0e095695d444), [`9867b9f`](https://github.com/Effect-TS/effect/commit/9867b9fc69f9cc6c443594fc7eccc7be0c674d9c), [`d0f1a22`](https://github.com/Effect-TS/effect/commit/d0f1a2295155c350b04efb46852cb40032805273), [`979ce39`](https://github.com/Effect-TS/effect/commit/979ce3985d7d62ce2bf240681ca19feda3027452), [`b6d3e67`](https://github.com/Effect-TS/effect/commit/b6d3e67c7cc143cd8470cdf704324e79d23954a9), [`adf6c6c`](https://github.com/Effect-TS/effect/commit/adf6c6cd388af8a3c0c546492e71555368556f6a), [`7314d60`](https://github.com/Effect-TS/effect/commit/7314d605284717aaafe7fc34b88c3c93397e865c), [`aeba0c8`](https://github.com/Effect-TS/effect/commit/aeba0c8c9ffc5f125d961ae21e4ac15491e51046), [`1acbd8b`](https://github.com/Effect-TS/effect/commit/1acbd8b44c68ebb23735e9810476b870dbe58aea), [`7bde6cc`](https://github.com/Effect-TS/effect/commit/7bde6ccb2b144fe953ff30a7ef5e1ecc97697146), [`a959a8b`](https://github.com/Effect-TS/effect/commit/a959a8bf21cdb976369f494dc949fa00a050d3e0)]:
  - effect@4.0.0-beta.103

## 4.0.0-beta.102

### Patch Changes

- [#6608](https://github.com/Effect-TS/effect/pull/6608) [`0e50ec7`](https://github.com/Effect-TS/effect/commit/0e50ec7dbb94390666f292cf9120719bf30a7246) Thanks @gcanti! - Add `Schema.Natural` for non-negative safe integers and use canonical `Schema.Int`, `Schema.Finite`, and `Schema.Natural` schemas for numeric domain values across Effect, AI protocols, and OpenAPI patches.

  Update the date, date-time, file, time-zone, cluster, event-log, persistence, socket, SQL, and DevTools schemas to reject invalid non-finite or non-integer values where appropriate. Correct the decoded schema of `Schema.NumberFromString`, and allow `Schema.DurationFromMillis` and `Schema.DurationFromNanos` to represent negative durations.

- [#6650](https://github.com/Effect-TS/effect/pull/6650) [`acd385e`](https://github.com/Effect-TS/effect/commit/acd385ebb3f9edee37ab6715607119ee9762a615) Thanks @IMax153! - Redact the Anthropic API key from client error context.

- [#6567](https://github.com/Effect-TS/effect/pull/6567) [`5101e92`](https://github.com/Effect-TS/effect/commit/5101e92c9c149c153423f43dd7a94f6194653c06) Thanks @gcanti! - Add `Record.assignProperty` and safely handle dynamic record keys such as `__proto__` and inherited property names.

- Updated dependencies [[`b6392e1`](https://github.com/Effect-TS/effect/commit/b6392e119704553edec1b4fd2869ac0dbec621ef), [`7ed9450`](https://github.com/Effect-TS/effect/commit/7ed945044eb56aa9aeaf62d4746a011c96c58628), [`45762bd`](https://github.com/Effect-TS/effect/commit/45762bd78df9ecd87c98b8d3738cdeeac7d81128), [`a6e8391`](https://github.com/Effect-TS/effect/commit/a6e8391cd31acd898fae18b3f8e7ca4c6f14f065), [`4ac7e8b`](https://github.com/Effect-TS/effect/commit/4ac7e8b136c61a26c3e438c013dfd7349b38e999), [`4cd40f5`](https://github.com/Effect-TS/effect/commit/4cd40f5692477783bef84fed3c5ef1c0cf5602e6), [`6956bc0`](https://github.com/Effect-TS/effect/commit/6956bc0e6cb27f53fbec39d9b18545940f9f598f), [`0e50ec7`](https://github.com/Effect-TS/effect/commit/0e50ec7dbb94390666f292cf9120719bf30a7246), [`9fcdade`](https://github.com/Effect-TS/effect/commit/9fcdade4a8af772b9ccd8b8a24fe8cee0e5d8470), [`57367d5`](https://github.com/Effect-TS/effect/commit/57367d54de55047ff0c5fce9685475e236bf354c), [`35c445f`](https://github.com/Effect-TS/effect/commit/35c445ff18029d192900ea0914c993f58d5cf1a5), [`c917bb9`](https://github.com/Effect-TS/effect/commit/c917bb94a4c1c4e0a24372a8ebb8a5ca232e36b5), [`bc1f358`](https://github.com/Effect-TS/effect/commit/bc1f3583e63344cb2c398d9040d9c975488ed123), [`0e0c9d7`](https://github.com/Effect-TS/effect/commit/0e0c9d7922ff463c1093d9e0576fae12cb0698d5), [`73d40aa`](https://github.com/Effect-TS/effect/commit/73d40aacd8fcae1b48c23f5b0a5c542127401d1d), [`4f1e318`](https://github.com/Effect-TS/effect/commit/4f1e3183f7123591c46224e9c587df7594562a5f), [`9d8d85c`](https://github.com/Effect-TS/effect/commit/9d8d85c1bb7da51970845b8ea830e386e777514a), [`6079fda`](https://github.com/Effect-TS/effect/commit/6079fda7b02f2f01ad91c15ab8c307336f3ba252), [`5101e92`](https://github.com/Effect-TS/effect/commit/5101e92c9c149c153423f43dd7a94f6194653c06), [`d0b3265`](https://github.com/Effect-TS/effect/commit/d0b3265c3262670761471ab3518cf933b1b3b20a), [`7a03c89`](https://github.com/Effect-TS/effect/commit/7a03c893ce6492bf94c0ebfb00b63bf25dcbf83e), [`cea1d9c`](https://github.com/Effect-TS/effect/commit/cea1d9c92601e69ebda040af8a1d860d604d885c), [`078e1f5`](https://github.com/Effect-TS/effect/commit/078e1f5636e31b76a86722a636afc37a8cc25580), [`97bafea`](https://github.com/Effect-TS/effect/commit/97bafeab460833b9781527b437d1cb9cbee63260), [`fab0ab8`](https://github.com/Effect-TS/effect/commit/fab0ab8f7ab15ae596faa4ccf75615a494d11b0b), [`c323d8b`](https://github.com/Effect-TS/effect/commit/c323d8b30dbbe85f9df25b67288b93d5332de333), [`6966353`](https://github.com/Effect-TS/effect/commit/69663534d626003eb10a5e55ab1f13e0379fead1), [`0444004`](https://github.com/Effect-TS/effect/commit/04440041989c1785fe4db286379f2be2c15baa85), [`028bbb3`](https://github.com/Effect-TS/effect/commit/028bbb391e161185da10d974ab33381f769940d7), [`ff5d6e2`](https://github.com/Effect-TS/effect/commit/ff5d6e278a1fdff714315dc1a17075012f05c1f0), [`1bfce93`](https://github.com/Effect-TS/effect/commit/1bfce93e6d2bf0794c11733daf51c2390e7de375), [`7ce815c`](https://github.com/Effect-TS/effect/commit/7ce815cd5af6af991dfc13b890fd22345fc77c20), [`7271a7f`](https://github.com/Effect-TS/effect/commit/7271a7faf1080aa75f2f53ca6a0b5ec9334c1d38), [`475fe5c`](https://github.com/Effect-TS/effect/commit/475fe5c12c2d6504c475797c0634f90da01e1797)]:
  - effect@4.0.0-beta.102

## 4.0.0-beta.101

### Patch Changes

- Updated dependencies [[`731bea1`](https://github.com/Effect-TS/effect/commit/731bea19416755a904ff5e809413e5922785d0a4), [`731bea1`](https://github.com/Effect-TS/effect/commit/731bea19416755a904ff5e809413e5922785d0a4), [`731bea1`](https://github.com/Effect-TS/effect/commit/731bea19416755a904ff5e809413e5922785d0a4), [`731bea1`](https://github.com/Effect-TS/effect/commit/731bea19416755a904ff5e809413e5922785d0a4), [`731bea1`](https://github.com/Effect-TS/effect/commit/731bea19416755a904ff5e809413e5922785d0a4), [`b35ed29`](https://github.com/Effect-TS/effect/commit/b35ed2904f01536d303b21f288daf343cf740462), [`dd44624`](https://github.com/Effect-TS/effect/commit/dd446245736a0e88c807a02f03c21450bb9340fa), [`731bea1`](https://github.com/Effect-TS/effect/commit/731bea19416755a904ff5e809413e5922785d0a4), [`2bae1ac`](https://github.com/Effect-TS/effect/commit/2bae1accce9d3b72cf6d5aefc9b2161af6d88436)]:
  - effect@4.0.0-beta.101

## 4.0.0-beta.100

### Patch Changes

- Updated dependencies [[`c1288dd`](https://github.com/Effect-TS/effect/commit/c1288dd1a52a2811ab7df57fc4ce236c6be4c745), [`2b58a3d`](https://github.com/Effect-TS/effect/commit/2b58a3dab6bc99776dddaf76e27d811e0f47f3d8), [`6dc83f2`](https://github.com/Effect-TS/effect/commit/6dc83f26ddf20d48db28cf761dd8f3716e5273fb), [`c1e2fe0`](https://github.com/Effect-TS/effect/commit/c1e2fe0cf93564f4d919e3998874c3e70b0cf30f), [`f3fbae8`](https://github.com/Effect-TS/effect/commit/f3fbae8d7bae0d77cb4f35a1598b26c58e3bf94d), [`e000f80`](https://github.com/Effect-TS/effect/commit/e000f80fd55bcd8edc699fdbf4cd109004f4f754), [`f4ee765`](https://github.com/Effect-TS/effect/commit/f4ee7655ee052cf9ba726fd602bb87c89c7c62a9), [`510b55f`](https://github.com/Effect-TS/effect/commit/510b55f3e21750685dbfd5f476a130c1c5af9dbd), [`31d3fc4`](https://github.com/Effect-TS/effect/commit/31d3fc4327c50867bb8d881fa7353aeb03ea2826), [`875e618`](https://github.com/Effect-TS/effect/commit/875e618c3764a7b817ac863d0af86924449528f2), [`688d46a`](https://github.com/Effect-TS/effect/commit/688d46afd0ef923d983ad3d7385f52f217b28d70), [`6ff5023`](https://github.com/Effect-TS/effect/commit/6ff502363b9840a5a5ee0a24bc6cae734ac3a3eb), [`c0333e7`](https://github.com/Effect-TS/effect/commit/c0333e7f755f42ddcca7051e029da8b4eed527bf), [`06e7e8c`](https://github.com/Effect-TS/effect/commit/06e7e8c66015ee318f871b9d2218dee82df2b108), [`eb9b102`](https://github.com/Effect-TS/effect/commit/eb9b10256c8558881b441c2fef833b7037174400), [`8b155da`](https://github.com/Effect-TS/effect/commit/8b155da06e0740c354ec562957a45ab65eb4573b), [`3a87335`](https://github.com/Effect-TS/effect/commit/3a8733564c5db35271aa20564ed0d344daa2a79f)]:
  - effect@4.0.0-beta.100

## 4.0.0-beta.99

### Patch Changes

- [#6371](https://github.com/Effect-TS/effect/pull/6371) [`7543afe`](https://github.com/Effect-TS/effect/commit/7543afea6f4d97d1f1ad876224323838a48daadd) Thanks @polRk! - Fix client-executed provider tools (Memory, Text Editor, Computer Use, Bash) which were unusable on the wire.
  - `makeResponse` (and the streaming equivalents) now map a provider `tool_use` wire name (e.g. `"memory"`) back to the tool's custom name (e.g. `"AnthropicMemory"`) that the toolkit is keyed by, instead of raising `ToolNotFoundError`.
  - `AnthropicTool.MemoryCreateCommand` now includes the required `file_text` field, so a `create` command no longer drops the file body.
  - Optional parameters on client-executed provider tools now use `Schema.optionalKey` instead of `Schema.optional`, which the Anthropic codec rejected with "Unsupported AST Undefined": `Memory`/`TextEditor` `view_range`, `ComputerUse` `coordinate`, and `Bash` `restart`.

  Closes [#2615](https://github.com/Effect-TS/effect/issues/2615).

- Updated dependencies [[`8ce4795`](https://github.com/Effect-TS/effect/commit/8ce4795ccbaebca4292757db568c005a992546a4), [`80b539f`](https://github.com/Effect-TS/effect/commit/80b539f8aba68f478c75c35c2b4140c4ffc4fada), [`88a54cc`](https://github.com/Effect-TS/effect/commit/88a54cc341006e3ebcb13482c618f62a680ce199), [`e6e6dba`](https://github.com/Effect-TS/effect/commit/e6e6dba6e9d86e7c2ad27dcedf289db76a19697f), [`bfb203e`](https://github.com/Effect-TS/effect/commit/bfb203e95aa439f731acad37fc3a9a831a190f1c), [`2e9a34a`](https://github.com/Effect-TS/effect/commit/2e9a34ac2bece4f3a206160480c991e3841dc67a), [`55d4eb3`](https://github.com/Effect-TS/effect/commit/55d4eb34f2c64d54f6a25a305b5c5438ebd7934e), [`bddb010`](https://github.com/Effect-TS/effect/commit/bddb010eac3d4436cb094edbbee7460c5440c162), [`a328835`](https://github.com/Effect-TS/effect/commit/a328835e50d76bc96648a1c1550456e8c9f81210), [`5560d05`](https://github.com/Effect-TS/effect/commit/5560d05aa6abdd29466d9c3412cc5e648b0adbde), [`8f6e3ad`](https://github.com/Effect-TS/effect/commit/8f6e3adb185b16e8820b98c509b308086f7ff1af), [`46997fa`](https://github.com/Effect-TS/effect/commit/46997fa60401f5e3c93daa4b61f7df8e31caaab4), [`9e6e12d`](https://github.com/Effect-TS/effect/commit/9e6e12d75c118cd265496f2880490d1f33a5c8bf), [`3394b93`](https://github.com/Effect-TS/effect/commit/3394b93d97d6f24fc38670641d1490289ffca7f1), [`febeabc`](https://github.com/Effect-TS/effect/commit/febeabc3f7c31094da000a23edeaabfe2ab00a38), [`54161c9`](https://github.com/Effect-TS/effect/commit/54161c98f6f3569e0c31842f54e6a257f9421c4c), [`385f7a4`](https://github.com/Effect-TS/effect/commit/385f7a4ee4a7359928597ea56d151dbaf5eb5802), [`7eea4d0`](https://github.com/Effect-TS/effect/commit/7eea4d0b73ec554915d7066a71f46326ce2ba45f), [`7543afe`](https://github.com/Effect-TS/effect/commit/7543afea6f4d97d1f1ad876224323838a48daadd), [`44b9cf3`](https://github.com/Effect-TS/effect/commit/44b9cf3d240d726997b4bbcd0ede48e074d3c456), [`7eea4d0`](https://github.com/Effect-TS/effect/commit/7eea4d0b73ec554915d7066a71f46326ce2ba45f), [`0a8aa6a`](https://github.com/Effect-TS/effect/commit/0a8aa6acb90a72b91c24d17133c950e4cacd8abd), [`c8d9fcf`](https://github.com/Effect-TS/effect/commit/c8d9fcf7b030f7c474effbab2764ce7aee1c7209), [`9ca7f9a`](https://github.com/Effect-TS/effect/commit/9ca7f9a69363e4485645966d5a93b8f9597c5206), [`e7aca89`](https://github.com/Effect-TS/effect/commit/e7aca894bb32fbb785b5830837e6061c415a6015), [`55d7560`](https://github.com/Effect-TS/effect/commit/55d75609b8acf8a1b54c1b1c7fbbb65ec741aa3e), [`f809189`](https://github.com/Effect-TS/effect/commit/f809189ddf6b6011ba43a9901baaa734e315da2a), [`88a54cc`](https://github.com/Effect-TS/effect/commit/88a54cc341006e3ebcb13482c618f62a680ce199), [`0ebdbe7`](https://github.com/Effect-TS/effect/commit/0ebdbe74463dc84385956d0b1e8c2b79ebab5400), [`7517d09`](https://github.com/Effect-TS/effect/commit/7517d09f12a0b183a81bd425962c4e280a68b05d), [`212493b`](https://github.com/Effect-TS/effect/commit/212493b9a1eb98cd1ef6959c707a2e5784a5ae91), [`88a54cc`](https://github.com/Effect-TS/effect/commit/88a54cc341006e3ebcb13482c618f62a680ce199), [`80ea8cb`](https://github.com/Effect-TS/effect/commit/80ea8cb9222ca73f564c8267ab2f82966fea027a), [`8df19f4`](https://github.com/Effect-TS/effect/commit/8df19f4fe81d90cc33ace88b9a77e5534f82d604)]:
  - effect@4.0.0-beta.99

## 4.0.0-beta.98

### Patch Changes

- Updated dependencies [[`989603b`](https://github.com/Effect-TS/effect-smol/commit/989603b60ab1197b64acf214208e0d370cd1f842), [`214c458`](https://github.com/Effect-TS/effect-smol/commit/214c458084bb6995d543cd37d1055f24be3d454e), [`a037273`](https://github.com/Effect-TS/effect-smol/commit/a0372736ac34796969b051bbba4717d7983f1ebe), [`97fdaa9`](https://github.com/Effect-TS/effect-smol/commit/97fdaa9c1f522c65e579365d314a07878e2b904f), [`b24d248`](https://github.com/Effect-TS/effect-smol/commit/b24d248c8df44222ce642087cde2bd859a2dc709), [`19c222c`](https://github.com/Effect-TS/effect-smol/commit/19c222cac2353a3d7b7733caecb00556fffe9a5c), [`eec85dd`](https://github.com/Effect-TS/effect-smol/commit/eec85ddba09ea326fd268ee33eeffd47e50d4671), [`0082f4f`](https://github.com/Effect-TS/effect-smol/commit/0082f4f74fb139fd578f87f0a790e845133983dc), [`8849052`](https://github.com/Effect-TS/effect-smol/commit/884905232d1e9a365e046d8dde27bf9c5707f57f), [`c15e16a`](https://github.com/Effect-TS/effect-smol/commit/c15e16ad130d1fbde25d912b7ac55995066cb35b), [`01d00a3`](https://github.com/Effect-TS/effect-smol/commit/01d00a3abfbf1f37996cdbe738ea5137c646cdd7), [`8bd4589`](https://github.com/Effect-TS/effect-smol/commit/8bd458975a1b3a8ed042eccf317b93d28ded91e7), [`0082f4f`](https://github.com/Effect-TS/effect-smol/commit/0082f4f74fb139fd578f87f0a790e845133983dc), [`6e08428`](https://github.com/Effect-TS/effect-smol/commit/6e08428d980501b856f846ad3f3f0e4ea46e7786), [`388dcf9`](https://github.com/Effect-TS/effect-smol/commit/388dcf953f65d317547f34d40e6443c5f264205f), [`2b7ce2b`](https://github.com/Effect-TS/effect-smol/commit/2b7ce2b513e7ec2a77822f1116dc6ffb6ba93f4e), [`87bea7e`](https://github.com/Effect-TS/effect-smol/commit/87bea7e16259246f3bcdf565446394751abca953), [`ce38dc3`](https://github.com/Effect-TS/effect-smol/commit/ce38dc33bda805a684432cca071f4dc3c6b9a1ba), [`a807cd1`](https://github.com/Effect-TS/effect-smol/commit/a807cd170341deca8a1cfb52c4222585f2431bb9), [`fd8a356`](https://github.com/Effect-TS/effect-smol/commit/fd8a356f06a8c9ce4e7e0a13fc4021c178ed31de), [`c2a5edc`](https://github.com/Effect-TS/effect-smol/commit/c2a5edc3abd31ad5bc123362bc1213e03e4095c3), [`5946da3`](https://github.com/Effect-TS/effect-smol/commit/5946da3804a1be5e752b05b96bd058cdba50a1bf), [`4ae0c5f`](https://github.com/Effect-TS/effect-smol/commit/4ae0c5ffcbe6c56ddfcb05c639112a079483539e), [`5b2a0bc`](https://github.com/Effect-TS/effect-smol/commit/5b2a0bceea3a28a33a58555210c90a415dc74a76), [`72ac585`](https://github.com/Effect-TS/effect-smol/commit/72ac585884befde6af9208da738699a93f1bae79), [`5e8c1b8`](https://github.com/Effect-TS/effect-smol/commit/5e8c1b82bfafa121311f987a49ab75395e3647a7), [`0f9c078`](https://github.com/Effect-TS/effect-smol/commit/0f9c07841b04183f485ee6e6458de73b290b09f5)]:
  - effect@4.0.0-beta.98

## 4.0.0-beta.97

### Patch Changes

- [#2568](https://github.com/Effect-TS/effect-smol/pull/2568) [`97a4138`](https://github.com/Effect-TS/effect-smol/commit/97a4138f9e9d31d38026f935b52d423f5ccadc4f) Thanks @K-Mistele! - Widen the Anthropic `Model` schema to accept both known model identifiers as well
  as any string to allow for newer models
- Updated dependencies []:
  - effect@4.0.0-beta.97

## 4.0.0-beta.96

### Patch Changes

- Updated dependencies [[`1503f45`](https://github.com/Effect-TS/effect-smol/commit/1503f45cb5bb2a74f4705252ec505a1f0ade7e62), [`57fe793`](https://github.com/Effect-TS/effect-smol/commit/57fe79316ffbc380b30626a168981fb26ae97459), [`0c2f78f`](https://github.com/Effect-TS/effect-smol/commit/0c2f78f695ec474e1ff5474da183577975e418f5), [`0c2f78f`](https://github.com/Effect-TS/effect-smol/commit/0c2f78f695ec474e1ff5474da183577975e418f5), [`0c2f78f`](https://github.com/Effect-TS/effect-smol/commit/0c2f78f695ec474e1ff5474da183577975e418f5), [`97f29df`](https://github.com/Effect-TS/effect-smol/commit/97f29df457f7ffd07cfb4b379315c12c086af805)]:
  - effect@4.0.0-beta.96

## 4.0.0-beta.95

### Patch Changes

- [#2531](https://github.com/Effect-TS/effect-smol/pull/2531) [`bdca354`](https://github.com/Effect-TS/effect-smol/commit/bdca35449d5dfce5b4433da75ec0a88d0a9b2b27) Thanks @polRk! - Fix `Memory_20250818` provider-defined tool missing `requiresHandler: true`. Like the other client-executed tools (`TextEditor_20250728`, `Bash_2025*`, `ComputerUse_2025*`), the memory tool requires the application to implement its execution (view/create/str_replace/insert/delete/rename over `/memories/*`). Without this flag, `Tool.HandlersFor` excluded it from the required handlers, making it impossible to type-check a handler for `Memory_20250818` in `Toolkit.toLayer`.

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

- [#2450](https://github.com/Effect-TS/effect-smol/pull/2450) [`7b8a549`](https://github.com/Effect-TS/effect-smol/commit/7b8a5493950aa6f9e20024cd7e588838722218f0) Thanks @DomiR! - Fix non-streaming Anthropic responses throwing when a tool call carries `caller` metadata. The mapper emitted `caller.toolId: undefined`, but `ProviderMetadata` is `Record(String, NullOr(Json))` and `undefined` is not a valid Json value, so decoding the model's own response threw `Expected JSON value`. Emit `null` instead, matching the streaming mappers.

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

- [#2357](https://github.com/Effect-TS/effect-smol/pull/2357) [`3efe308`](https://github.com/Effect-TS/effect-smol/commit/3efe308fcc6ac642c65560efbd1b3afc68052553) Thanks @jbmusso! - Mark the Claude 4-6 generation as supporting native structured output in `getModelCapabilities`. `claude-opus-4-6` and `claude-sonnet-4-6` support Anthropic's constrained-decoding structured output (verified against the live API), but were classified as `supportsStructuredOutput: false`, so `generateObject` fell back to a forced JSON tool instead of requesting `output_config.format` (`json_schema`). `claude-opus-4-7` / `claude-opus-4-8` are classified the same way for when the generated `Model` enum picks them up.

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

- Updated dependencies [[`73e67d1`](https://github.com/Effect-TS/effect-smol/commit/73e67d119a84d697773eaecb4865c6a71eb1a9cb), [`01d71ec`](https://github.com/Effect-TS/effect-smol/commit/01d71ec5a75f3c2747a8d3b1ad9701d1e27b7ce5), [`fcd707e`](https://github.com/Effect-TS/effect-smol/commit/fcd707e091a16e1b35343c901cc4052274e32239)]:
  - effect@4.0.0-beta.72

## 4.0.0-beta.71

### Patch Changes

- Updated dependencies [[`d8ac76b`](https://github.com/Effect-TS/effect-smol/commit/d8ac76b5bad458c42cebe8a0c1b3843f955ac293), [`2c3c00a`](https://github.com/Effect-TS/effect-smol/commit/2c3c00af6faba7b7d422af26a7a2bbc35636d230), [`3751e7c`](https://github.com/Effect-TS/effect-smol/commit/3751e7cf353e7a54cd692c37401207d9afba1e63), [`fc5f25b`](https://github.com/Effect-TS/effect-smol/commit/fc5f25b03ada5fc2431987768a74d3d3e75ca485), [`7ccced4`](https://github.com/Effect-TS/effect-smol/commit/7ccced42867c14c013b01160b3d292f14c05bd04), [`a2e1fe5`](https://github.com/Effect-TS/effect-smol/commit/a2e1fe5835c98c8ee4393a091b1d11b75126e349), [`4a4a36b`](https://github.com/Effect-TS/effect-smol/commit/4a4a36b10e6e616cad07584a43908f6a7e07e618), [`d350292`](https://github.com/Effect-TS/effect-smol/commit/d3502922b4740fa9d745797cbc3775cb67839b6d), [`730afb6`](https://github.com/Effect-TS/effect-smol/commit/730afb66696adf9bd5a328cbca29df9c05968771), [`df1b008`](https://github.com/Effect-TS/effect-smol/commit/df1b008f370f414c2a67a7b8139ef747af8e5fba), [`6d469d5`](https://github.com/Effect-TS/effect-smol/commit/6d469d567a7c41d7e5343bdee21d45b07b0e8190)]:
  - effect@4.0.0-beta.71

## 4.0.0-beta.70

### Patch Changes

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

- Updated dependencies [[`0768509`](https://github.com/Effect-TS/effect-smol/commit/07685094e931af07d104165195826a535b55fa7e), [`476aede`](https://github.com/Effect-TS/effect-smol/commit/476aede69c6efa06b5781ca5eb3e3b128ca29141), [`4f79c54`](https://github.com/Effect-TS/effect-smol/commit/4f79c542e7b508c235ff485d862cc8b29a8260c5), [`4be6a7c`](https://github.com/Effect-TS/effect-smol/commit/4be6a7cf35dab2a01d652f56dd35f0358c5a7e88), [`88927eb`](https://github.com/Effect-TS/effect-smol/commit/88927ebb896162cdba103b36553280b58e0facac)]:
  - effect@4.0.0-beta.53

## 4.0.0-beta.52

### Patch Changes

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

- Updated dependencies [[`2ae33d0`](https://github.com/Effect-TS/effect-smol/commit/2ae33d050914915f7cb9c25ab0a020901e08d596), [`979811a`](https://github.com/Effect-TS/effect-smol/commit/979811a4c3f7ed21ed18ef560c49fb7f5569e80e), [`eb7dbef`](https://github.com/Effect-TS/effect-smol/commit/eb7dbeffa883386ad912815e62c0820cac1fdf8e), [`cf50eb4`](https://github.com/Effect-TS/effect-smol/commit/cf50eb49cb04706dae5185f624708117c413dee8), [`1d046fe`](https://github.com/Effect-TS/effect-smol/commit/1d046fe484560e23f3e22cb23eec6433f8f1fa02)]:
  - effect@4.0.0-beta.43

## 4.0.0-beta.42

### Patch Changes

- Updated dependencies [[`924e216`](https://github.com/Effect-TS/effect-smol/commit/924e216caa7e0bbf22e994a0cd2ce8b1f0f0b3ee), [`80e7f0c`](https://github.com/Effect-TS/effect-smol/commit/80e7f0cd9116e811e97b0ce30a77a8d1ecd072aa), [`f8328bf`](https://github.com/Effect-TS/effect-smol/commit/f8328bf0314da3dc7f31d314f94a5840e8d5217f), [`66d1c06`](https://github.com/Effect-TS/effect-smol/commit/66d1c06039079129707a230f7ad8c676439d7133), [`bee800b`](https://github.com/Effect-TS/effect-smol/commit/bee800bf285192a01bec72a7b7b51bc1159434e6), [`8930441`](https://github.com/Effect-TS/effect-smol/commit/8930441dee6f94c59c583d18d3ebd677cf1f2623)]:
  - effect@4.0.0-beta.42

## 4.0.0-beta.41

### Patch Changes

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

- [#1775](https://github.com/Effect-TS/effect-smol/pull/1775) [`954e6d6`](https://github.com/Effect-TS/effect-smol/commit/954e6d655cd32d329b0bfeb872bb654f88b48a13) Thanks @tim-smart! - Add dynamic tool support to the Anthropic language model provider when preparing tool definitions for requests.

- Updated dependencies [[`60fcbcc`](https://github.com/Effect-TS/effect-smol/commit/60fcbcc43d09471e8f7e0969955d99dcefc5be81), [`0a60837`](https://github.com/Effect-TS/effect-smol/commit/0a6083713124440e630030375bab367e8d7df24e), [`49164d2`](https://github.com/Effect-TS/effect-smol/commit/49164d2c20a8d21b66514992c4a15d8521f6b36e), [`334b6e4`](https://github.com/Effect-TS/effect-smol/commit/334b6e4f76fe11941b516d61f57e268bc31f0ca6), [`5700695`](https://github.com/Effect-TS/effect-smol/commit/5700695f76ae6da6b94c9c87d4dd2b8054fb829b), [`f8f4456`](https://github.com/Effect-TS/effect-smol/commit/f8f445644f3aa7ec093cab7445198a62ba18a480), [`969d24f`](https://github.com/Effect-TS/effect-smol/commit/969d24fdfa48c4838e811983848d9cb4e9b3b12c), [`851eda0`](https://github.com/Effect-TS/effect-smol/commit/851eda0533946e39bacaaf581896320d7a4f3e8c), [`8059c1c`](https://github.com/Effect-TS/effect-smol/commit/8059c1c3eba9a90af7cd889ea261bcb8fff0c185), [`6f83295`](https://github.com/Effect-TS/effect-smol/commit/6f8329546a73eaddc7cb5e85ea8e37e73fbfb611), [`65f7f57`](https://github.com/Effect-TS/effect-smol/commit/65f7f5737575fed668987462c96d29a446707c32), [`e7fabd2`](https://github.com/Effect-TS/effect-smol/commit/e7fabd2265db690eae5cfc9b83730c84699aef61), [`89c3e98`](https://github.com/Effect-TS/effect-smol/commit/89c3e985401eb38f33a3ae21a94ad27de3c1d28b), [`53794ab`](https://github.com/Effect-TS/effect-smol/commit/53794ab7af30aa5c5004ecf53659fafbe4b10542)]:
  - effect@4.0.0-beta.36

## 4.0.0-beta.35

### Patch Changes

- Updated dependencies [[`9252b43`](https://github.com/Effect-TS/effect-smol/commit/9252b43560f507709c2985abcf52a7837b23ddf8), [`7daf387`](https://github.com/Effect-TS/effect-smol/commit/7daf3870a656882a488a60f67881e6808c8f4d04), [`e1664a3`](https://github.com/Effect-TS/effect-smol/commit/e1664a38bc31ef4ceb4e9324c7226e1e99bf9c07), [`fdaa6e0`](https://github.com/Effect-TS/effect-smol/commit/fdaa6e0a41b6b6605438fa8557441792135380a2), [`19aa47e`](https://github.com/Effect-TS/effect-smol/commit/19aa47ef7b470e427620edca8970dd9cdd551216), [`c667dad`](https://github.com/Effect-TS/effect-smol/commit/c667dad07777b860e4764a3ba9a6cc41c236cd98), [`764d150`](https://github.com/Effect-TS/effect-smol/commit/764d1501bc5026b60fc8aef6cb02a5a87c762801), [`3c27098`](https://github.com/Effect-TS/effect-smol/commit/3c27098b5685a63db2c2eff654a250c94d3fcfa7)]:
  - effect@4.0.0-beta.35

## 4.0.0-beta.34

### Patch Changes

- [#1763](https://github.com/Effect-TS/effect-smol/pull/1763) [`2fa940d`](https://github.com/Effect-TS/effect-smol/commit/2fa940d0709769c5fd1337c1f88400867f91989b) Thanks @teeverc! - Remove duplicate `ToolApprovalResponsePartOptions` from Anthropic package

- Updated dependencies [[`f2f75ee`](https://github.com/Effect-TS/effect-smol/commit/f2f75ee564bce1cd95f5189c7bdeeed4f92dacb1), [`342fc4b`](https://github.com/Effect-TS/effect-smol/commit/342fc4b051739e32e7977159f26ff9541eda664f), [`5d704ee`](https://github.com/Effect-TS/effect-smol/commit/5d704ee10d20e8eb107e34bb8a21feb5aa4a7685), [`00add69`](https://github.com/Effect-TS/effect-smol/commit/00add69b59551e9df34772eb927638b093f6d71e), [`58217d3`](https://github.com/Effect-TS/effect-smol/commit/58217d318a7d716ccd707cce0f41573946939c28), [`f4e2aba`](https://github.com/Effect-TS/effect-smol/commit/f4e2aba01b76d1e3059b297e3cc942284dfeafb2), [`e3b44b6`](https://github.com/Effect-TS/effect-smol/commit/e3b44b6a2af9ee21dc5c1e928f0c20af857fa7a9), [`e1472b7`](https://github.com/Effect-TS/effect-smol/commit/e1472b7525c5d57a48bdec2353c3b742f7f916c0), [`7686320`](https://github.com/Effect-TS/effect-smol/commit/7686320cd123fa352b5c3d076fb18a3cac0a9bba)]:
  - effect@4.0.0-beta.34

## 4.0.0-beta.33

### Patch Changes

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

- Updated dependencies []:
  - effect@4.0.0-beta.19

## 4.0.0-beta.18

### Patch Changes

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

- [#1333](https://github.com/Effect-TS/effect-smol/pull/1333) [`96260bf`](https://github.com/Effect-TS/effect-smol/commit/96260bf5331fad6e38d2a79e94d70fd9a502ec29) Thanks @IMax153! - Fix tool calling for the Anthropic Effect AI SDK provider integration

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
