struct HighlightCSS {
    static func light(_ theme: HighlightTheme) -> String {
        switch theme {
        case .a11y:
            /*
             Theme: a11y-light
             Author: @ericwbailey
             Maintainer: @ericwbailey
             Based on the Tomorrow Night Eighties theme: https://github.com/isagalaev/highlight.js/blob/master/src/styles/tomorrow-night-eighties.css
             */
            return "pre code.hljs{display:block;overflow-x:auto;padding:1em}code.hljs{padding:3px 5px}.hljs{color:#545454}.hljs-comment,.hljs-quote{color:#696969}.hljs-deletion,.hljs-name,.hljs-regexp,.hljs-selector-class,.hljs-selector-id,.hljs-tag,.hljs-template-variable,.hljs-variable{color:#d91e18}.hljs-attribute,.hljs-built_in,.hljs-link,.hljs-literal,.hljs-meta,.hljs-number,.hljs-params,.hljs-type{color:#aa5d00}.hljs-addition,.hljs-bullet,.hljs-string,.hljs-symbol{color:green}.hljs-section,.hljs-title{color:#007faa}.hljs-keyword,.hljs-selector-tag{color:#7928a1}.hljs-emphasis{font-style:italic}.hljs-strong{font-weight:700}@media screen and (-ms-high-contrast:active){.hljs-addition,.hljs-attribute,.hljs-built_in,.hljs-bullet,.hljs-comment,.hljs-link,.hljs-literal,.hljs-meta,.hljs-number,.hljs-params,.hljs-quote,.hljs-string,.hljs-symbol,.hljs-type{color:highlight}.hljs-keyword,.hljs-selector-tag{font-weight:700}}"
        case .atomOne:
            return "pre code.hljs{display:block;overflow-x:auto;padding:1em}code.hljs{padding:3px 5px}.hljs{color:#383a42}.hljs-comment,.hljs-quote{color:#a0a1a7;font-style:italic}.hljs-doctag,.hljs-formula,.hljs-keyword{color:#a626a4}.hljs-deletion,.hljs-name,.hljs-section,.hljs-selector-tag,.hljs-subst{color:#e45649}.hljs-literal{color:#0184bb}.hljs-addition,.hljs-attribute,.hljs-meta .hljs-string,.hljs-regexp,.hljs-string{color:#50a14f}.hljs-attr,.hljs-number,.hljs-selector-attr,.hljs-selector-class,.hljs-selector-pseudo,.hljs-template-variable,.hljs-type,.hljs-variable{color:#986801}.hljs-bullet,.hljs-link,.hljs-meta,.hljs-selector-id,.hljs-symbol,.hljs-title{color:#4078f2}.hljs-built_in,.hljs-class .hljs-title,.hljs-title.class_{color:#c18401}.hljs-emphasis{font-style:italic}.hljs-strong{font-weight:700}.hljs-link{text-decoration:underline}"
        case .classic:
            /*
             Theme: Classic Light
             Author: Jason Heeris (http://heeris.id.au)
             License: ~ MIT (or more permissive) [via base16-schemes-source]
             Maintainer: @highlightjs/core-team
             Version: 2021.09.0
             */
            return "pre code.hljs{display:block;overflow-x:auto;padding:1em}code.hljs{padding:3px 5px}.hljs{color:#303030}.hljs ::selection,.hljs::selection{color:#303030}.hljs-comment{color:#b0b0b0}.hljs-tag{color:#505050}.hljs-operator,.hljs-punctuation,.hljs-subst{color:#303030}.hljs-operator{opacity:.7}.hljs-bullet,.hljs-deletion,.hljs-name,.hljs-selector-tag,.hljs-template-variable,.hljs-variable{color:#ac4142}.hljs-attr,.hljs-link,.hljs-literal,.hljs-number,.hljs-symbol,.hljs-variable.constant_{color:#d28445}.hljs-class .hljs-title,.hljs-title,.hljs-title.class_{color:#f4bf75}.hljs-strong{font-weight:700;color:#f4bf75}.hljs-addition,.hljs-code,.hljs-string,.hljs-title.class_.inherited__{color:#90a959}.hljs-built_in,.hljs-doctag,.hljs-keyword.hljs-atrule,.hljs-quote,.hljs-regexp{color:#75b5aa}.hljs-attribute,.hljs-function .hljs-title,.hljs-section,.hljs-title.function_,.ruby .hljs-property{color:#6a9fb5}.diff .hljs-meta,.hljs-keyword,.hljs-template-tag,.hljs-type{color:#aa759f}.hljs-emphasis{color:#aa759f;font-style:italic}.hljs-meta,.hljs-meta .hljs-keyword,.hljs-meta .hljs-string{color:#8f5536}.hljs-meta .hljs-keyword,.hljs-meta-keyword{font-weight:700}"
        case .edge:
            /*
             Theme: Edge Light
             Author: cjayross (https://github.com/cjayross)
             License: ~ MIT (or more permissive) [via base16-schemes-source]
             Maintainer: @highlightjs/core-team
             Version: 2021.09.0
             */
            return "pre code.hljs{display:block;overflow-x:auto;padding:1em}code.hljs{padding:3px 5px}.hljs{color:#5e646f}.hljs ::selection,.hljs::selection{color:#5e646f}.hljs-comment{color:#5e646f}.hljs-tag{color:#6587bf}.hljs-operator,.hljs-punctuation,.hljs-subst{color:#5e646f}.hljs-operator{opacity:.7}.hljs-attr,.hljs-bullet,.hljs-deletion,.hljs-link,.hljs-literal,.hljs-name,.hljs-number,.hljs-selector-tag,.hljs-symbol,.hljs-template-variable,.hljs-variable,.hljs-variable.constant_{color:#db7070}.hljs-class .hljs-title,.hljs-title,.hljs-title.class_{color:#d69822}.hljs-strong{font-weight:700;color:#d69822}.hljs-addition,.hljs-code,.hljs-string,.hljs-title.class_.inherited__{color:#7c9f4b}.hljs-built_in,.hljs-doctag,.hljs-keyword.hljs-atrule,.hljs-quote,.hljs-regexp{color:#509c93}.hljs-attribute,.hljs-function .hljs-title,.hljs-section,.hljs-title.function_,.ruby .hljs-property{color:#6587bf}.diff .hljs-meta,.hljs-keyword,.hljs-template-tag,.hljs-type{color:#b870ce}.hljs-emphasis{color:#b870ce;font-style:italic}.hljs-meta,.hljs-meta .hljs-keyword,.hljs-meta .hljs-string{color:#509c93}.hljs-meta .hljs-keyword,.hljs-meta-keyword{font-weight:700}"
        case .github:
            /*
              Theme: Github
              Author: Defman21
              License: ~ MIT (or more permissive) [via base16-schemes-source]
              Maintainer: @highlightjs/core-team
              Version: 2021.09.0
            */
            return "pre code.hljs{display:block;overflow-x:auto;padding:1em}code.hljs{padding:3px 5px}.hljs{color:#333}.hljs ::selection,.hljs::selection{color:#333}.hljs-comment{color:#969896}.hljs-tag{color:#e8e8e8}.hljs-operator,.hljs-punctuation,.hljs-subst{color:#333}.hljs-operator{opacity:.7}.hljs-bullet,.hljs-deletion,.hljs-name,.hljs-selector-tag,.hljs-template-variable,.hljs-variable{color:#ed6a43}.hljs-attr,.hljs-link,.hljs-literal,.hljs-number,.hljs-symbol,.hljs-variable.constant_{color:#0086b3}.hljs-class .hljs-title,.hljs-title,.hljs-title.class_{color:#795da3}.hljs-strong{font-weight:700;color:#795da3}.hljs-addition,.hljs-built_in,.hljs-code,.hljs-doctag,.hljs-keyword.hljs-atrule,.hljs-quote,.hljs-regexp,.hljs-string,.hljs-title.class_.inherited__{color:#183691}.hljs-attribute,.hljs-function .hljs-title,.hljs-section,.hljs-title.function_,.ruby .hljs-property{color:#795da3}.diff .hljs-meta,.hljs-keyword,.hljs-template-tag,.hljs-type{color:#a71d5d}.hljs-emphasis{color:#a71d5d;font-style:italic}.hljs-meta,.hljs-meta .hljs-keyword,.hljs-meta .hljs-string{color:#333}.hljs-meta .hljs-keyword,.hljs-meta-keyword{font-weight:700}"
        case .google:
            /*
             Theme: Google Light
             Author: Seth Wright (http://sethawright.com)
             License: ~ MIT (or more permissive) [via base16-schemes-source]
             Maintainer: @highlightjs/core-team
             Version: 2021.09.0
             */
            return "pre code.hljs{display:block;overflow-x:auto;padding:1em}code.hljs{padding:3px 5px}.hljs{color:#373b41}.hljs ::selection,.hljs::selection{color:#373b41}.hljs-comment{color:#b4b7b4}.hljs-tag{color:#969896}.hljs-operator,.hljs-punctuation,.hljs-subst{color:#373b41}.hljs-operator{opacity:.7}.hljs-bullet,.hljs-deletion,.hljs-name,.hljs-selector-tag,.hljs-template-variable,.hljs-variable{color:#cc342b}.hljs-attr,.hljs-link,.hljs-literal,.hljs-number,.hljs-symbol,.hljs-variable.constant_{color:#f96a38}.hljs-class .hljs-title,.hljs-title,.hljs-title.class_{color:#fba922}.hljs-strong{font-weight:700;color:#fba922}.hljs-addition,.hljs-code,.hljs-string,.hljs-title.class_.inherited__{color:#198844}.hljs-attribute,.hljs-built_in,.hljs-doctag,.hljs-function .hljs-title,.hljs-keyword.hljs-atrule,.hljs-quote,.hljs-regexp,.hljs-section,.hljs-title.function_,.ruby .hljs-property{color:#3971ed}.diff .hljs-meta,.hljs-keyword,.hljs-template-tag,.hljs-type{color:#a36ac7}.hljs-emphasis{color:#a36ac7;font-style:italic}.hljs-meta,.hljs-meta .hljs-keyword,.hljs-meta .hljs-string{color:#3971ed}.hljs-meta .hljs-keyword,.hljs-meta-keyword{font-weight:700}"
        case .gradient:
            return "pre code.hljs{display:block;overflow-x:auto;padding:1em}code.hljs{padding:3px 5px}.hljs{color:#250482}.hljs-subtr{color:#01958b}.hljs-comment,.hljs-doctag,.hljs-meta,.hljs-quote{color:#cb7200}.hljs-attr,.hljs-regexp,.hljs-selector-id,.hljs-selector-tag,.hljs-tag,.hljs-template-tag{color:#07bd5f}.hljs-bullet,.hljs-params,.hljs-selector-class{color:#43449f}.hljs-keyword,.hljs-meta .hljs-keyword,.hljs-section,.hljs-symbol,.hljs-type{color:#7d2801}.hljs-addition,.hljs-link,.hljs-number{color:#7f0096}.hljs-string{color:#2681ab}.hljs-addition,.hljs-attribute{color:#296562}.hljs-template-variable,.hljs-variable{color:#025c8f}.hljs-built_in,.hljs-class,.hljs-formula,.hljs-function,.hljs-name,.hljs-title{color:#529117}.hljs-deletion,.hljs-literal,.hljs-selector-pseudo{color:#ad13ff}.hljs-emphasis,.hljs-quote{font-style:italic}.hljs-keyword,.hljs-params,.hljs-section,.hljs-selector-class,.hljs-selector-id,.hljs-selector-tag,.hljs-strong,.hljs-template-tag{font-weight:700}"
        case .grayscale:
            /*
             Theme: Grayscale Light
             Author: Alexandre Gavioli (https://github.com/Alexx2/)
             License: ~ MIT (or more permissive) [via base16-schemes-source]
             Maintainer: @highlightjs/core-team
             Version: 2021.09.0
             */
            return "pre code.hljs{display:block;overflow-x:auto;padding:1em}code.hljs{padding:3px 5px}.hljs{color:#464646}.hljs ::selection,.hljs::selection{color:#464646}.hljs-comment{color:#ababab}.hljs-tag{color:#525252}.hljs-operator,.hljs-punctuation,.hljs-subst{color:#464646}.hljs-operator{opacity:.7}.hljs-bullet,.hljs-deletion,.hljs-name,.hljs-selector-tag,.hljs-template-variable,.hljs-variable{color:#7c7c7c}.hljs-attr,.hljs-link,.hljs-literal,.hljs-number,.hljs-symbol,.hljs-variable.constant_{color:#999}.hljs-class .hljs-title,.hljs-title,.hljs-title.class_{color:#a0a0a0}.hljs-strong{font-weight:700;color:#a0a0a0}.hljs-addition,.hljs-code,.hljs-string,.hljs-title.class_.inherited__{color:#8e8e8e}.hljs-built_in,.hljs-doctag,.hljs-keyword.hljs-atrule,.hljs-quote,.hljs-regexp{color:#868686}.hljs-attribute,.hljs-function .hljs-title,.hljs-section,.hljs-title.function_,.ruby .hljs-property{color:#686868}.diff .hljs-meta,.hljs-keyword,.hljs-template-tag,.hljs-type{color:#747474}.hljs-emphasis{color:#747474;font-style:italic}.hljs-meta,.hljs-meta .hljs-keyword,.hljs-meta .hljs-string{color:#5e5e5e}.hljs-meta .hljs-keyword,.hljs-meta-keyword{font-weight:700}"
        case .harmonic16:
            /*
             Theme: Harmonic16 Light
             Author: Jannik Siebert (https://github.com/janniks)
             License: ~ MIT (or more permissive) [via base16-schemes-source]
             Maintainer: @highlightjs/core-team
             Version: 2021.09.0
             */
            return "pre code.hljs{display:block;overflow-x:auto;padding:1em}code.hljs{padding:3px 5px}.hljs{color:#405c79}.hljs ::selection,.hljs::selection{color:#405c79}.hljs-comment{color:#aabcce}.hljs-tag{color:#627e99}.hljs-operator,.hljs-punctuation,.hljs-subst{color:#405c79}.hljs-operator{opacity:.7}.hljs-bullet,.hljs-deletion,.hljs-name,.hljs-selector-tag,.hljs-template-variable,.hljs-variable{color:#bf8b56}.hljs-attr,.hljs-link,.hljs-literal,.hljs-number,.hljs-symbol,.hljs-variable.constant_{color:#bfbf56}.hljs-class .hljs-title,.hljs-title,.hljs-title.class_{color:#8bbf56}.hljs-strong{font-weight:700;color:#8bbf56}.hljs-addition,.hljs-code,.hljs-string,.hljs-title.class_.inherited__{color:#56bf8b}.hljs-built_in,.hljs-doctag,.hljs-keyword.hljs-atrule,.hljs-quote,.hljs-regexp{color:#568bbf}.hljs-attribute,.hljs-function .hljs-title,.hljs-section,.hljs-title.function_,.ruby .hljs-property{color:#8b56bf}.diff .hljs-meta,.hljs-keyword,.hljs-template-tag,.hljs-type{color:#bf568b}.hljs-emphasis{color:#bf568b;font-style:italic}.hljs-meta,.hljs-meta .hljs-keyword,.hljs-meta .hljs-string{color:#bf5656}.hljs-meta .hljs-keyword,.hljs-meta-keyword{font-weight:700}"
        case .heetch:
            /*
             Theme: Heetch Light
             Author: Geoffrey Teale (tealeg@gmail.com)
             License: ~ MIT (or more permissive) [via base16-schemes-source]
             Maintainer: @highlightjs/core-team
             Version: 2021.09.0
             */
            return "pre code.hljs{display:block;overflow-x:auto;padding:1em}code.hljs{padding:3px 5px}.hljs{color:#5a496e}.hljs ::selection,.hljs::selection{color:#5a496e}.hljs-comment{color:#9c92a8}.hljs-tag{color:#ddd6e5}.hljs-operator,.hljs-punctuation,.hljs-subst{color:#5a496e}.hljs-operator{opacity:.7}.hljs-bullet,.hljs-deletion,.hljs-name,.hljs-selector-tag,.hljs-template-variable,.hljs-variable{color:#27d9d5}.hljs-attr,.hljs-link,.hljs-literal,.hljs-number,.hljs-symbol,.hljs-variable.constant_{color:#bdb6c5}.hljs-class .hljs-title,.hljs-title,.hljs-title.class_{color:#5ba2b6}.hljs-strong{font-weight:700;color:#5ba2b6}.hljs-addition,.hljs-code,.hljs-string,.hljs-title.class_.inherited__{color:#f80059}.hljs-built_in,.hljs-doctag,.hljs-keyword.hljs-atrule,.hljs-quote,.hljs-regexp{color:#c33678}.hljs-attribute,.hljs-function .hljs-title,.hljs-section,.hljs-title.function_,.ruby .hljs-property{color:#47f9f5}.diff .hljs-meta,.hljs-keyword,.hljs-template-tag,.hljs-type{color:#bd0152}.hljs-emphasis{color:#bd0152;font-style:italic}.hljs-meta,.hljs-meta .hljs-keyword,.hljs-meta .hljs-string{color:#dedae2}.hljs-meta .hljs-keyword,.hljs-meta-keyword{font-weight:700}"
        case .horizon:
            /*
             Theme: Horizon Light
             Author: Michaël Ball (http://github.com/michael-ball/)
             License: ~ MIT (or more permissive) [via base16-schemes-source]
             Maintainer: @highlightjs/core-team
             Version: 2021.09.0
             */
            return "pre code.hljs{display:block;overflow-x:auto;padding:1em}code.hljs{padding:3px 5px}.hljs{color:#403c3d}.hljs ::selection,.hljs::selection{color:#403c3d}.hljs-comment{color:#bdb3b1}.hljs-tag{color:#948c8a}.hljs-operator,.hljs-punctuation,.hljs-subst{color:#403c3d}.hljs-operator{opacity:.7}.hljs-bullet,.hljs-deletion,.hljs-name,.hljs-selector-tag,.hljs-template-variable,.hljs-variable{color:#e95678}.hljs-attr,.hljs-link,.hljs-literal,.hljs-number,.hljs-symbol,.hljs-variable.constant_{color:#f9cec3}.hljs-class .hljs-title,.hljs-title,.hljs-title.class_{color:#fadad1}.hljs-strong{font-weight:700;color:#fadad1}.hljs-addition,.hljs-code,.hljs-string,.hljs-title.class_.inherited__{color:#29d398}.hljs-built_in,.hljs-doctag,.hljs-keyword.hljs-atrule,.hljs-quote,.hljs-regexp{color:#59e1e3}.hljs-attribute,.hljs-function .hljs-title,.hljs-section,.hljs-title.function_,.ruby .hljs-property{color:#26bbd9}.diff .hljs-meta,.hljs-keyword,.hljs-template-tag,.hljs-type{color:#ee64ac}.hljs-emphasis{color:#ee64ac;font-style:italic}.hljs-meta,.hljs-meta .hljs-keyword,.hljs-meta .hljs-string{color:#f9cbbe}.hljs-meta .hljs-keyword,.hljs-meta-keyword{font-weight:700}"
        case .humanoid:
            /*
             Theme: Humanoid light
             Author: Thomas (tasmo) Friese
             License: ~ MIT (or more permissive) [via base16-schemes-source]
             Maintainer: @highlightjs/core-team
             Version: 2021.09.0
             */
            return "pre code.hljs{display:block;overflow-x:auto;padding:1em}code.hljs{padding:3px 5px}.hljs{color:#232629}.hljs ::selection,.hljs::selection{color:#232629}.hljs-comment{color:#c0c0bd}.hljs-tag{color:#60615d}.hljs-operator,.hljs-punctuation,.hljs-subst{color:#232629}.hljs-operator{opacity:.7}.hljs-bullet,.hljs-deletion,.hljs-name,.hljs-selector-tag,.hljs-template-variable,.hljs-variable{color:#b0151a}.hljs-attr,.hljs-link,.hljs-literal,.hljs-number,.hljs-symbol,.hljs-variable.constant_{color:#ff3d00}.hljs-class .hljs-title,.hljs-title,.hljs-title.class_{color:#ffb627}.hljs-strong{font-weight:700;color:#ffb627}.hljs-addition,.hljs-code,.hljs-string,.hljs-title.class_.inherited__{color:#388e3c}.hljs-built_in,.hljs-doctag,.hljs-keyword.hljs-atrule,.hljs-quote,.hljs-regexp{color:#008e8e}.hljs-attribute,.hljs-function .hljs-title,.hljs-section,.hljs-title.function_,.ruby .hljs-property{color:#0082c9}.diff .hljs-meta,.hljs-keyword,.hljs-template-tag,.hljs-type{color:#700f98}.hljs-emphasis{color:#700f98;font-style:italic}.hljs-meta,.hljs-meta .hljs-keyword,.hljs-meta .hljs-string{color:#b27701}.hljs-meta .hljs-keyword,.hljs-meta-keyword{font-weight:700}"
        case .ia:
            /*
             Theme: iA Light
             Author: iA Inc. (modified by aramisgithub)
             License: ~ MIT (or more permissive) [via base16-schemes-source]
             Maintainer: @highlightjs/core-team
             Version: 2021.09.0
             */
            return "pre code.hljs{display:block;overflow-x:auto;padding:1em}code.hljs{padding:3px 5px}.hljs{color:#181818}.hljs ::selection,.hljs::selection{color:#181818}.hljs-comment{color:#898989}.hljs-tag{color:#767676}.hljs-operator,.hljs-punctuation,.hljs-subst{color:#181818}.hljs-operator{opacity:.7}.hljs-bullet,.hljs-deletion,.hljs-name,.hljs-selector-tag,.hljs-template-variable,.hljs-variable{color:#9c5a02}.hljs-attr,.hljs-link,.hljs-literal,.hljs-number,.hljs-symbol,.hljs-variable.constant_{color:#c43e18}.hljs-class .hljs-title,.hljs-title,.hljs-title.class_{color:#c48218}.hljs-strong{font-weight:700;color:#c48218}.hljs-addition,.hljs-code,.hljs-string,.hljs-title.class_.inherited__{color:#38781c}.hljs-built_in,.hljs-doctag,.hljs-keyword.hljs-atrule,.hljs-quote,.hljs-regexp{color:#2d6bb1}.hljs-attribute,.hljs-function .hljs-title,.hljs-section,.hljs-title.function_,.ruby .hljs-property{color:#48bac2}.diff .hljs-meta,.hljs-keyword,.hljs-template-tag,.hljs-type{color:#a94598}.hljs-emphasis{color:#a94598;font-style:italic}.hljs-meta,.hljs-meta .hljs-keyword,.hljs-meta .hljs-string{color:#8b6c37}.hljs-meta .hljs-keyword,.hljs-meta-keyword{font-weight:700}"
        case .isblEditor:
            return "pre code.hljs{display:block;overflow-x:auto;padding:1em}code.hljs{padding:3px 5px}.hljs{color:#000}.hljs-subst{color:#000}.hljs-comment{color:#555;font-style:italic}.hljs-attribute,.hljs-doctag,.hljs-keyword,.hljs-meta .hljs-keyword,.hljs-name,.hljs-selector-tag{color:#000;font-weight:700}.hljs-string{color:navy}.hljs-deletion,.hljs-number,.hljs-quote,.hljs-selector-class,.hljs-selector-id,.hljs-template-tag,.hljs-type{color:#000}.hljs-link,.hljs-regexp,.hljs-selector-attr,.hljs-selector-pseudo,.hljs-symbol,.hljs-template-variable,.hljs-variable{color:#5e1700}.hljs-built_in,.hljs-literal{color:navy;font-weight:700}.hljs-addition,.hljs-bullet,.hljs-code{color:#397300}.hljs-class{color:#6f1c00;font-weight:700}.hljs-section,.hljs-title{color:#fb2c00}.hljs-title>.hljs-built_in{color:teal;font-weight:400}.hljs-meta{color:#1f7199}.hljs-meta .hljs-string{color:#4d99bf}.hljs-emphasis{font-style:italic}.hljs-strong{font-weight:700}"
        case .kimbie:
            return "pre code.hljs{display:block;overflow-x:auto;padding:1em}code.hljs{padding:3px 5px}.hljs{color:#84613d}.hljs-comment,.hljs-quote{color:#a57a4c}.hljs-meta,.hljs-name,.hljs-regexp,.hljs-selector-class,.hljs-selector-id,.hljs-tag,.hljs-template-variable,.hljs-variable{color:#dc3958}.hljs-built_in,.hljs-deletion,.hljs-link,.hljs-literal,.hljs-number,.hljs-params,.hljs-type{color:#f79a32}.hljs-addition,.hljs-bullet,.hljs-string,.hljs-symbol{color:#889b4a}.hljs-function,.hljs-keyword,.hljs-selector-tag{color:#98676a}.hljs-attribute,.hljs-section,.hljs-title{color:#f06431}.hljs-emphasis{font-style:italic}.hljs-strong{font-weight:700}"
        case .nnfx:
            /*
             Theme: nnfx light
             Description: a theme inspired by Netscape Navigator/Firefox
             Author: (c) 2020-2021 Jim Mason <jmason@ibinx.com>
             Maintainer: @RocketMan
             License: https://creativecommons.org/licenses/by-sa/4.0  CC BY-SA 4.0
             Updated: 2021-05-17

             @version 1.1.0
             */
            return "pre code.hljs{display:block;overflow-x:auto;padding:1em}code.hljs{padding:3px 5px}.hljs{color:#000}.language-xml .hljs-meta,.language-xml .hljs-meta-string{font-weight:700;font-style:italic;color:#48b}.hljs-comment,.hljs-quote{font-style:italic;color:#070}.hljs-built_in,.hljs-keyword,.hljs-name{color:#808}.hljs-attr,.hljs-name{font-weight:700}.hljs-string{font-weight:400}.hljs-code,.hljs-link,.hljs-meta .hljs-string,.hljs-number,.hljs-regexp,.hljs-string{color:#00f}.hljs-bullet,.hljs-symbol,.hljs-template-variable,.hljs-title,.hljs-variable{color:#f40}.hljs-class .hljs-title,.hljs-title.class_,.hljs-type{font-weight:700;color:#639}.hljs-attr,.hljs-function .hljs-title,.hljs-subst,.hljs-tag,.hljs-title.function_{color:#000}.hljs-formula{font-style:italic}.hljs-meta{color:#269}.hljs-section,.hljs-selector-class,.hljs-selector-id,.hljs-selector-pseudo,.hljs-selector-tag{font-weight:700;color:#48b}.hljs-selector-pseudo{font-style:italic}.hljs-doctag,.hljs-strong{font-weight:700}.hljs-emphasis{font-style:italic}"
        case .pandaSyntax:
            return "pre code.hljs{display:block;overflow-x:auto;padding:1em}code.hljs{padding:3px 5px}.hljs{color:#2a2c2d}.hljs-emphasis{font-style:italic}.hljs-strong{font-weight:700}.hljs-link{text-decoration:underline}.hljs-comment,.hljs-quote{color:#676b79;font-style:italic}.hljs-params{color:#676b79}.hljs-attr,.hljs-punctuation{color:#2a2c2d}.hljs-char.escape_,.hljs-meta,.hljs-name,.hljs-operator,.hljs-selector-tag{color:#c56200}.hljs-deletion,.hljs-keyword{color:#d92792}.hljs-regexp,.hljs-selector-attr,.hljs-selector-pseudo,.hljs-variable.language_{color:#cc5e91}.hljs-code,.hljs-formula,.hljs-property,.hljs-section,.hljs-subst,.hljs-title.function_{color:#3787c7}.hljs-addition,.hljs-bullet,.hljs-meta .hljs-string,.hljs-selector-class,.hljs-string,.hljs-symbol,.hljs-title.class_,.hljs-title.class_.inherited__{color:#0d7d6c}.hljs-attribute,.hljs-built_in,.hljs-doctag,.hljs-link,.hljs-literal,.hljs-meta .hljs-keyword,.hljs-number,.hljs-selector-id,.hljs-tag,.hljs-template-tag,.hljs-template-variable,.hljs-title,.hljs-type,.hljs-variable{color:#7641bb}"
        case .papercolor:
            /*
             Theme: PaperColor Light
             Author: Jon Leopard (http://github.com/jonleopard) based on PaperColor Theme (https://github.com/NLKNguyen/papercolor-theme)
             License: ~ MIT (or more permissive) [via base16-schemes-source]
             Maintainer: @highlightjs/core-team
             Version: 2021.09.0
             */
            return "pre code.hljs{display:block;overflow-x:auto;padding:1em}code.hljs{padding:3px 5px}.hljs{color:#444}.hljs ::selection,.hljs::selection{color:#444}.hljs-comment{color:#5f8700}.hljs-tag{color:#0087af}.hljs-operator,.hljs-punctuation,.hljs-subst{color:#444}.hljs-operator{opacity:.7}.hljs-bullet,.hljs-deletion,.hljs-name,.hljs-selector-tag,.hljs-template-variable,.hljs-variable{color:#bcbcbc}.hljs-attr,.hljs-link,.hljs-literal,.hljs-number,.hljs-symbol,.hljs-variable.constant_{color:#d70000}.hljs-class .hljs-title,.hljs-title,.hljs-title.class_{color:#d70087}.hljs-strong{font-weight:700;color:#d70087}.hljs-addition,.hljs-code,.hljs-string,.hljs-title.class_.inherited__{color:#8700af}.hljs-attribute,.hljs-built_in,.hljs-doctag,.hljs-function .hljs-title,.hljs-keyword.hljs-atrule,.hljs-quote,.hljs-regexp,.hljs-section,.hljs-title.function_,.ruby .hljs-property{color:#d75f00}.diff .hljs-meta,.hljs-keyword,.hljs-template-tag,.hljs-type{color:#005faf}.hljs-emphasis{color:#005faf;font-style:italic}.hljs-meta,.hljs-meta .hljs-keyword,.hljs-meta .hljs-string{color:#005f87}.hljs-meta .hljs-keyword,.hljs-meta-keyword{font-weight:700}"
        case .paraiso:
            return "pre code.hljs{display:block;overflow-x:auto;padding:1em}code.hljs{padding:3px 5px}.hljs{color:#4f424c}.hljs-comment,.hljs-quote{color:#776e71}.hljs-link,.hljs-meta,.hljs-name,.hljs-regexp,.hljs-selector-class,.hljs-selector-id,.hljs-tag,.hljs-template-variable,.hljs-variable{color:#ef6155}.hljs-built_in,.hljs-deletion,.hljs-literal,.hljs-number,.hljs-params,.hljs-type{color:#f99b15}.hljs-attribute,.hljs-section,.hljs-title{color:#fec418}.hljs-addition,.hljs-bullet,.hljs-string,.hljs-symbol{color:#48b685}.hljs-keyword,.hljs-selector-tag{color:#815ba4}.hljs-emphasis{font-style:italic}.hljs-strong{font-weight:700}"
        case .qtcreator:
            return "pre code.hljs{display:block;overflow-x:auto;padding:1em}code.hljs{padding:3px 5px}.hljs{color:#000}.hljs-emphasis,.hljs-strong{color:#000}.hljs-bullet,.hljs-literal,.hljs-number,.hljs-quote,.hljs-regexp{color:navy}.hljs-code .hljs-selector-class{color:purple}.hljs-emphasis,.hljs-stronge,.hljs-type{font-style:italic}.hljs-function,.hljs-keyword,.hljs-name,.hljs-section,.hljs-selector-tag,.hljs-symbol{color:olive}.hljs-subst,.hljs-tag,.hljs-title{color:#000}.hljs-attribute{color:maroon}.hljs-class .hljs-title,.hljs-params,.hljs-title.class_,.hljs-variable{color:#0055af}.hljs-addition,.hljs-built_in,.hljs-comment,.hljs-deletion,.hljs-link,.hljs-meta,.hljs-selector-attr,.hljs-selector-id,.hljs-selector-pseudo,.hljs-string,.hljs-template-tag,.hljs-template-variable,.hljs-type{color:green}"
        case .silk:
            /*
             Theme: Silk Light
             Author: Gabriel Fontes (https://github.com/Misterio77)
             License: ~ MIT (or more permissive) [via base16-schemes-source]
             Maintainer: @highlightjs/core-team
             Version: 2021.09.0
             */
            return "pre code.hljs{display:block;overflow-x:auto;padding:1em}code.hljs{padding:3px 5px}.hljs{color:#385156}.hljs ::selection,.hljs::selection{color:#385156}.hljs-comment{color:#5c787b}.hljs-tag{color:#4b5b5f}.hljs-operator,.hljs-punctuation,.hljs-subst{color:#385156}.hljs-operator{opacity:.7}.hljs-bullet,.hljs-deletion,.hljs-name,.hljs-selector-tag,.hljs-template-variable,.hljs-variable{color:#cf432e}.hljs-attr,.hljs-link,.hljs-literal,.hljs-number,.hljs-symbol,.hljs-variable.constant_{color:#d27f46}.hljs-class .hljs-title,.hljs-title,.hljs-title.class_{color:#cfad25}.hljs-strong{font-weight:700;color:#cfad25}.hljs-addition,.hljs-code,.hljs-string,.hljs-title.class_.inherited__{color:#6ca38c}.hljs-built_in,.hljs-doctag,.hljs-keyword.hljs-atrule,.hljs-quote,.hljs-regexp{color:#329ca2}.hljs-attribute,.hljs-function .hljs-title,.hljs-section,.hljs-title.function_,.ruby .hljs-property{color:#39aac9}.diff .hljs-meta,.hljs-keyword,.hljs-template-tag,.hljs-type{color:#6e6582}.hljs-emphasis{color:#6e6582;font-style:italic}.hljs-meta,.hljs-meta .hljs-keyword,.hljs-meta .hljs-string{color:#865369}.hljs-meta .hljs-keyword,.hljs-meta-keyword{font-weight:700}"
        case .solarFlare:
            /*
             Theme: Solar Flare Light
             Author: Chuck Harmston (https://chuck.harmston.ch)
             License: ~ MIT (or more permissive) [via base16-schemes-source]
             Maintainer: @highlightjs/core-team
             Version: 2021.09.0
             */
            return "pre code.hljs{display:block;overflow-x:auto;padding:1em}code.hljs{padding:3px 5px}.hljs{color:#586875}.hljs ::selection,.hljs::selection{color:#586875}.hljs-comment{color:#85939e}.hljs-tag{color:#667581}.hljs-operator,.hljs-punctuation,.hljs-subst{color:#586875}.hljs-operator{opacity:.7}.hljs-bullet,.hljs-deletion,.hljs-name,.hljs-selector-tag,.hljs-template-variable,.hljs-variable{color:#ef5253}.hljs-attr,.hljs-link,.hljs-literal,.hljs-number,.hljs-symbol,.hljs-variable.constant_{color:#e66b2b}.hljs-class .hljs-title,.hljs-title,.hljs-title.class_{color:#e4b51c}.hljs-strong{font-weight:700;color:#e4b51c}.hljs-addition,.hljs-code,.hljs-string,.hljs-title.class_.inherited__{color:#7cc844}.hljs-built_in,.hljs-doctag,.hljs-keyword.hljs-atrule,.hljs-quote,.hljs-regexp{color:#52cbb0}.hljs-attribute,.hljs-function .hljs-title,.hljs-section,.hljs-title.function_,.ruby .hljs-property{color:#33b5e1}.diff .hljs-meta,.hljs-keyword,.hljs-template-tag,.hljs-type{color:#a363d5}.hljs-emphasis{color:#a363d5;font-style:italic}.hljs-meta,.hljs-meta .hljs-keyword,.hljs-meta .hljs-string{color:#d73c9a}.hljs-meta .hljs-keyword,.hljs-meta-keyword{font-weight:700}"
        case .solarized:
            /*
             Theme: Solarized Light
             Author: Ethan Schoonover (modified by aramisgithub)
             License: ~ MIT (or more permissive) [via base16-schemes-source]
             Maintainer: @highlightjs/core-team
             Version: 2021.09.0
             */
            return "pre code.hljs{display:block;overflow-x:auto;padding:1em}code.hljs{padding:3px 5px}.hljs{color:#586e75}.hljs ::selection,.hljs::selection{color:#586e75}.hljs-comment{color:#839496}.hljs-tag{color:#657b83}.hljs-operator,.hljs-punctuation,.hljs-subst{color:#586e75}.hljs-operator{opacity:.7}.hljs-bullet,.hljs-deletion,.hljs-name,.hljs-selector-tag,.hljs-template-variable,.hljs-variable{color:#dc322f}.hljs-attr,.hljs-link,.hljs-literal,.hljs-number,.hljs-symbol,.hljs-variable.constant_{color:#cb4b16}.hljs-class .hljs-title,.hljs-title,.hljs-title.class_{color:#b58900}.hljs-strong{font-weight:700;color:#b58900}.hljs-addition,.hljs-code,.hljs-string,.hljs-title.class_.inherited__{color:#859900}.hljs-built_in,.hljs-doctag,.hljs-keyword.hljs-atrule,.hljs-quote,.hljs-regexp{color:#2aa198}.hljs-attribute,.hljs-function .hljs-title,.hljs-section,.hljs-title.function_,.ruby .hljs-property{color:#268bd2}.diff .hljs-meta,.hljs-keyword,.hljs-template-tag,.hljs-type{color:#6c71c4}.hljs-emphasis{color:#6c71c4;font-style:italic}.hljs-meta,.hljs-meta .hljs-keyword,.hljs-meta .hljs-string{color:#d33682}.hljs-meta .hljs-keyword,.hljs-meta-keyword{font-weight:700}"
        case .stackoverflow:
            /*
             Theme: StackOverflow Light
             Description: Light theme as used on stackoverflow.com
             Author: stackoverflow.com
             Maintainer: @Hirse
             Website: https://github.com/StackExchange/Stacks
             License: MIT
             Updated: 2021-05-15

             Updated for @stackoverflow/stacks v0.64.0
             Code Blocks: /blob/v0.64.0/lib/css/components/_stacks-code-blocks.less
             Colors: /blob/v0.64.0/lib/css/exports/_stacks-constants-colors.less
             */
            return "pre code.hljs{display:block;overflow-x:auto;padding:1em}code.hljs{padding:3px 5px}.hljs{color:#2f3337}.hljs-subst{color:#2f3337}.hljs-comment{color:#656e77}.hljs-attr,.hljs-doctag,.hljs-keyword,.hljs-meta .hljs-keyword,.hljs-section,.hljs-selector-tag{color:#015692}.hljs-attribute{color:#803378}.hljs-name,.hljs-number,.hljs-quote,.hljs-selector-id,.hljs-template-tag,.hljs-type{color:#b75501}.hljs-selector-class{color:#015692}.hljs-link,.hljs-regexp,.hljs-selector-attr,.hljs-string,.hljs-symbol,.hljs-template-variable,.hljs-variable{color:#54790d}.hljs-meta,.hljs-selector-pseudo{color:#015692}.hljs-built_in,.hljs-literal,.hljs-title{color:#b75501}.hljs-bullet,.hljs-code{color:#535a60}.hljs-meta .hljs-string{color:#54790d}.hljs-deletion{color:#c02d2e}.hljs-addition{color:#2f6f44}.hljs-emphasis{font-style:italic}.hljs-strong{font-weight:700}"
        case .standard:
            /*
             Theme: Default Light
             Author: Chris Kempson (http://chriskempson.com)
             License: ~ MIT (or more permissive) [via base16-schemes-source]
             Maintainer: @highlightjs/core-team
             Version: 2021.09.0
             */
            return "pre code.hljs{display:block;overflow-x:auto;padding:1em}code.hljs{padding:3px 5px}.hljs{color:#383838}.hljs ::selection,.hljs::selection{color:#383838}.hljs-comment{color:#b8b8b8}.hljs-tag{color:#585858}.hljs-operator,.hljs-punctuation,.hljs-subst{color:#383838}.hljs-operator{opacity:.7}.hljs-bullet,.hljs-deletion,.hljs-name,.hljs-selector-tag,.hljs-template-variable,.hljs-variable{color:#ab4642}.hljs-attr,.hljs-link,.hljs-literal,.hljs-number,.hljs-symbol,.hljs-variable.constant_{color:#dc9656}.hljs-class .hljs-title,.hljs-title,.hljs-title.class_{color:#f7ca88}.hljs-strong{font-weight:700;color:#f7ca88}.hljs-addition,.hljs-code,.hljs-string,.hljs-title.class_.inherited__{color:#a1b56c}.hljs-built_in,.hljs-doctag,.hljs-keyword.hljs-atrule,.hljs-quote,.hljs-regexp{color:#86c1b9}.hljs-attribute,.hljs-function .hljs-title,.hljs-section,.hljs-title.function_,.ruby .hljs-property{color:#7cafc2}.diff .hljs-meta,.hljs-keyword,.hljs-template-tag,.hljs-type{color:#ba8baf}.hljs-emphasis{color:#ba8baf;font-style:italic}.hljs-meta,.hljs-meta .hljs-keyword,.hljs-meta .hljs-string{color:#a16946}.hljs-meta .hljs-keyword,.hljs-meta-keyword{font-weight:700}"
        case .summerfruit:
            /*
             Theme: Summerfruit Light
             Author: Christopher Corley (http://christop.club/)
             License: ~ MIT (or more permissive) [via base16-schemes-source]
             Maintainer: @highlightjs/core-team
             Version: 2021.09.0
             */
            return "pre code.hljs{display:block;overflow-x:auto;padding:1em}code.hljs{padding:3px 5px}.hljs{color:#101010}.hljs ::selection,.hljs::selection{color:#101010}.hljs-comment{color:#b0b0b0}.hljs-tag{color:#000}.hljs-operator,.hljs-punctuation,.hljs-subst{color:#101010}.hljs-operator{opacity:.7}.hljs-bullet,.hljs-deletion,.hljs-name,.hljs-selector-tag,.hljs-template-variable,.hljs-variable{color:#ff0086}.hljs-attr,.hljs-link,.hljs-literal,.hljs-number,.hljs-symbol,.hljs-variable.constant_{color:#fd8900}.hljs-class .hljs-title,.hljs-title,.hljs-title.class_{color:#aba800}.hljs-strong{font-weight:700;color:#aba800}.hljs-addition,.hljs-code,.hljs-string,.hljs-title.class_.inherited__{color:#00c918}.hljs-built_in,.hljs-doctag,.hljs-keyword.hljs-atrule,.hljs-quote,.hljs-regexp{color:#1faaaa}.hljs-attribute,.hljs-function .hljs-title,.hljs-section,.hljs-title.function_,.ruby .hljs-property{color:#3777e6}.diff .hljs-meta,.hljs-keyword,.hljs-template-tag,.hljs-type{color:#ad00a1}.hljs-emphasis{color:#ad00a1;font-style:italic}.hljs-meta,.hljs-meta .hljs-keyword,.hljs-meta .hljs-string{color:#c63}.hljs-meta .hljs-keyword,.hljs-meta-keyword{font-weight:700}"
        case .synthMidnightTerminal:
            /*
             Theme: Synth Midnight Terminal Light
             Author: Michaël Ball (http://github.com/michael-ball/)
             License: ~ MIT (or more permissive) [via base16-schemes-source]
             Maintainer: @highlightjs/core-team
             Version: 2021.09.0
             */
            return "pre code.hljs{display:block;overflow-x:auto;padding:1em}code.hljs{padding:3px 5px}.hljs{color:#28292a}.hljs ::selection,.hljs::selection{color:#28292a}.hljs-comment{color:#a3a5a6}.hljs-tag{color:#474849}.hljs-operator,.hljs-punctuation,.hljs-subst{color:#28292a}.hljs-operator{opacity:.7}.hljs-bullet,.hljs-deletion,.hljs-name,.hljs-selector-tag,.hljs-template-variable,.hljs-variable{color:#b53b50}.hljs-attr,.hljs-link,.hljs-literal,.hljs-number,.hljs-symbol,.hljs-variable.constant_{color:#ea770d}.hljs-class .hljs-title,.hljs-title,.hljs-title.class_{color:#c9d364}.hljs-strong{font-weight:700;color:#c9d364}.hljs-addition,.hljs-code,.hljs-string,.hljs-title.class_.inherited__{color:#06ea61}.hljs-built_in,.hljs-doctag,.hljs-keyword.hljs-atrule,.hljs-quote,.hljs-regexp{color:#42fff9}.hljs-attribute,.hljs-function .hljs-title,.hljs-section,.hljs-title.function_,.ruby .hljs-property{color:#03aeff}.diff .hljs-meta,.hljs-keyword,.hljs-template-tag,.hljs-type{color:#ea5ce2}.hljs-emphasis{color:#ea5ce2;font-style:italic}.hljs-meta,.hljs-meta .hljs-keyword,.hljs-meta .hljs-string{color:#cd6320}.hljs-meta .hljs-keyword,.hljs-meta-keyword{font-weight:700}"
        case .tokyoNight:
            /*
             Theme: Tokyo-night-light
             origin: https://github.com/enkia/tokyo-night-vscode-theme
             Description: Original highlight.js style
             Author: (c) Henri Vandersleyen <hvandersleyen@gmail.com>
             License: see project LICENSE
             Touched: 2022
             */
            return "pre code.hljs{display:block;overflow-x:auto;padding:1em}code.hljs{padding:3px 5px}.hljs-comment,.hljs-meta{color:#9699a3}.hljs-deletion,.hljs-doctag,.hljs-regexp,.hljs-selector-attr,.hljs-selector-class,.hljs-selector-id,.hljs-selector-pseudo,.hljs-tag,.hljs-template-tag,.hljs-variable.language_{color:#8c4351}.hljs-link,.hljs-literal,.hljs-number,.hljs-params,.hljs-template-variable,.hljs-type,.hljs-variable{color:#965027}.hljs-attribute,.hljs-built_in{color:#8f5e15}.hljs-keyword,.hljs-property,.hljs-subst,.hljs-title,.hljs-title.class_,.hljs-title.class_.inherited__,.hljs-title.function_{color:#0f4b6e}.hljs-selector-tag{color:#33635c}.hljs-addition,.hljs-bullet,.hljs-quote,.hljs-string,.hljs-symbol{color:#485e30}.hljs-code,.hljs-formula,.hljs-section{color:#34548a}.hljs-attr,.hljs-char.escape_,.hljs-keyword,.hljs-name,.hljs-operator{color:#5a4a78}.hljs-punctuation{color:#343b58}.hljs{color:#565a6e}.hljs-emphasis{font-style:italic}.hljs-strong{font-weight:700}"
        case .unikitty:
            /*
             Theme: Unikitty Light
             Author: Josh W Lewis (@joshwlewis)
             License: ~ MIT (or more permissive) [via base16-schemes-source]
             Maintainer: @highlightjs/core-team
             Version: 2021.09.0
             */
            return "pre code.hljs{display:block;overflow-x:auto;padding:1em}code.hljs{padding:3px 5px}.hljs{color:#6c696e}.hljs ::selection,.hljs::selection{color:#6c696e}.hljs-comment{color:#a7a5a8}.hljs-tag{color:#89878b}.hljs-operator,.hljs-punctuation,.hljs-subst{color:#6c696e}.hljs-operator{opacity:.7}.hljs-bullet,.hljs-deletion,.hljs-name,.hljs-selector-tag,.hljs-template-variable,.hljs-variable{color:#d8137f}.hljs-attr,.hljs-link,.hljs-literal,.hljs-number,.hljs-symbol,.hljs-variable.constant_{color:#d65407}.hljs-class .hljs-title,.hljs-title,.hljs-title.class_{color:#dc8a0e}.hljs-strong{font-weight:700;color:#dc8a0e}.hljs-addition,.hljs-code,.hljs-string,.hljs-title.class_.inherited__{color:#17ad98}.hljs-built_in,.hljs-doctag,.hljs-keyword.hljs-atrule,.hljs-quote,.hljs-regexp{color:#149bda}.hljs-attribute,.hljs-function .hljs-title,.hljs-section,.hljs-title.function_,.ruby .hljs-property{color:#775dff}.diff .hljs-meta,.hljs-keyword,.hljs-template-tag,.hljs-type{color:#aa17e6}.hljs-emphasis{color:#aa17e6;font-style:italic}.hljs-meta,.hljs-meta .hljs-keyword,.hljs-meta .hljs-string{color:#e013d0}.hljs-meta .hljs-keyword,.hljs-meta-keyword{font-weight:700}"
        case .xcode:
            return "pre code.hljs{display:block;overflow-x:auto;padding:1em}code.hljs{padding:3px 5px}.hljs{color:#000}.xml .hljs-meta{color:silver}.hljs-comment,.hljs-quote{color:#007400}.hljs-attribute,.hljs-keyword,.hljs-literal,.hljs-name,.hljs-selector-tag,.hljs-tag{color:#aa0d91}.hljs-template-variable,.hljs-variable{color:#3f6e74}.hljs-code,.hljs-meta .hljs-string,.hljs-string{color:#c41a16}.hljs-link,.hljs-regexp{color:#0e0eff}.hljs-bullet,.hljs-number,.hljs-symbol,.hljs-title{color:#1c00cf}.hljs-meta,.hljs-section{color:#643820}.hljs-built_in,.hljs-class .hljs-title,.hljs-params,.hljs-title.class_,.hljs-type{color:#5c2699}.hljs-attr{color:#836c28}.hljs-subst{color:#000}.hljs-formula{font-style:italic}.hljs-selector-class,.hljs-selector-id{color:#9b703f}.hljs-doctag,.hljs-strong{font-weight:700}.hljs-emphasis{font-style:italic}"
        }
    }

    static func dark(_ theme: HighlightTheme) -> String {
        switch theme {
        case .a11y:
            /*
             Theme: a11y-dark
             Author: @ericwbailey
             Maintainer: @ericwbailey

             Based on the Tomorrow Night Eighties theme: https://github.com/isagalaev/highlight.js/blob/master/src/styles/tomorrow-night-eighties.css
             */
            return "pre code.hljs{display:block;overflow-x:auto;padding:1em}code.hljs{padding:3px 5px}.hljs{color:#f8f8f2}.hljs-comment,.hljs-quote{color:#d4d0ab}.hljs-deletion,.hljs-name,.hljs-regexp,.hljs-selector-class,.hljs-selector-id,.hljs-tag,.hljs-template-variable,.hljs-variable{color:#ffa07a}.hljs-built_in,.hljs-link,.hljs-literal,.hljs-meta,.hljs-number,.hljs-params,.hljs-type{color:#f5ab35}.hljs-attribute{color:gold}.hljs-addition,.hljs-bullet,.hljs-string,.hljs-symbol{color:#abe338}.hljs-section,.hljs-title{color:#00e0e0}.hljs-keyword,.hljs-selector-tag{color:#dcc6e0}.hljs-emphasis{font-style:italic}.hljs-strong{font-weight:700}@media screen and (-ms-high-contrast:active){.hljs-addition,.hljs-attribute,.hljs-built_in,.hljs-bullet,.hljs-comment,.hljs-link,.hljs-literal,.hljs-meta,.hljs-number,.hljs-params,.hljs-quote,.hljs-string,.hljs-symbol,.hljs-type{color:highlight}.hljs-keyword,.hljs-selector-tag{font-weight:700}}"
        case .atomOne:
            return "pre code.hljs{display:block;overflow-x:auto;padding:1em}code.hljs{padding:3px 5px}.hljs{color:#abb2bf}.hljs-comment,.hljs-quote{color:#5c6370;font-style:italic}.hljs-doctag,.hljs-formula,.hljs-keyword{color:#c678dd}.hljs-deletion,.hljs-name,.hljs-section,.hljs-selector-tag,.hljs-subst{color:#e06c75}.hljs-literal{color:#56b6c2}.hljs-addition,.hljs-attribute,.hljs-meta .hljs-string,.hljs-regexp,.hljs-string{color:#98c379}.hljs-attr,.hljs-number,.hljs-selector-attr,.hljs-selector-class,.hljs-selector-pseudo,.hljs-template-variable,.hljs-type,.hljs-variable{color:#d19a66}.hljs-bullet,.hljs-link,.hljs-meta,.hljs-selector-id,.hljs-symbol,.hljs-title{color:#61aeee}.hljs-built_in,.hljs-class .hljs-title,.hljs-title.class_{color:#e6c07b}.hljs-emphasis{font-style:italic}.hljs-strong{font-weight:700}.hljs-link{text-decoration:underline}"
        case .classic:
            /*
             Theme: Classic Dark
             Author: Jason Heeris (http://heeris.id.au)
             License: ~ MIT (or more permissive) [via base16-schemes-source]
             Maintainer: @highlightjs/core-team
             Version: 2021.09.0
             */
            return "pre code.hljs{display:block;overflow-x:auto;padding:1em}code.hljs{padding:3px 5px}.hljs{color:#d0d0d0}.hljs ::selection,.hljs::selection{color:#d0d0d0}.hljs-comment{color:#505050}.hljs-tag{color:#b0b0b0}.hljs-operator,.hljs-punctuation,.hljs-subst{color:#d0d0d0}.hljs-operator{opacity:.7}.hljs-bullet,.hljs-deletion,.hljs-name,.hljs-selector-tag,.hljs-template-variable,.hljs-variable{color:#ac4142}.hljs-attr,.hljs-link,.hljs-literal,.hljs-number,.hljs-symbol,.hljs-variable.constant_{color:#d28445}.hljs-class .hljs-title,.hljs-title,.hljs-title.class_{color:#f4bf75}.hljs-strong{font-weight:700;color:#f4bf75}.hljs-addition,.hljs-code,.hljs-string,.hljs-title.class_.inherited__{color:#90a959}.hljs-built_in,.hljs-doctag,.hljs-keyword.hljs-atrule,.hljs-quote,.hljs-regexp{color:#75b5aa}.hljs-attribute,.hljs-function .hljs-title,.hljs-section,.hljs-title.function_,.ruby .hljs-property{color:#6a9fb5}.diff .hljs-meta,.hljs-keyword,.hljs-template-tag,.hljs-type{color:#aa759f}.hljs-emphasis{color:#aa759f;font-style:italic}.hljs-meta,.hljs-meta .hljs-keyword,.hljs-meta .hljs-string{color:#8f5536}.hljs-meta .hljs-keyword,.hljs-meta-keyword{font-weight:700}"
        case .edge:
            /*
             Theme: Edge Dark
             Author: cjayross (https://github.com/cjayross)
             License: ~ MIT (or more permissive) [via base16-schemes-source]
             Maintainer: @highlightjs/core-team
             Version: 2021.09.0
             */
            return "pre code.hljs{display:block;overflow-x:auto;padding:1em}code.hljs{padding:3px 5px}.hljs{color:#b7bec9}.hljs ::selection,.hljs::selection{color:#b7bec9}.hljs-comment{color:#3e4249}.hljs-tag{color:#73b3e7}.hljs-operator,.hljs-punctuation,.hljs-subst{color:#b7bec9}.hljs-operator{opacity:.7}.hljs-attr,.hljs-bullet,.hljs-deletion,.hljs-link,.hljs-literal,.hljs-name,.hljs-number,.hljs-selector-tag,.hljs-symbol,.hljs-template-variable,.hljs-variable,.hljs-variable.constant_{color:#e77171}.hljs-class .hljs-title,.hljs-title,.hljs-title.class_{color:#dbb774}.hljs-strong{font-weight:700;color:#dbb774}.hljs-addition,.hljs-code,.hljs-string,.hljs-title.class_.inherited__{color:#a1bf78}.hljs-built_in,.hljs-doctag,.hljs-keyword.hljs-atrule,.hljs-quote,.hljs-regexp{color:#5ebaa5}.hljs-attribute,.hljs-function .hljs-title,.hljs-section,.hljs-title.function_,.ruby .hljs-property{color:#73b3e7}.diff .hljs-meta,.hljs-keyword,.hljs-template-tag,.hljs-type{color:#d390e7}.hljs-emphasis{color:#d390e7;font-style:italic}.hljs-meta,.hljs-meta .hljs-keyword,.hljs-meta .hljs-string{color:#5ebaa5}.hljs-meta .hljs-keyword,.hljs-meta-keyword{font-weight:700}"
        case .github:
            /*
             Theme: GitHub Dark
             Description: Dark theme as seen on github.com
             Author: github.com
             Maintainer: @Hirse
             Updated: 2021-05-15

             Outdated base version: https://github.com/primer/github-syntax-dark
             Current colors taken from GitHub's CSS
             */
            return "pre code.hljs{display:block;overflow-x:auto;padding:1em}code.hljs{padding:3px 5px}.hljs{color:#c9d1d9}.hljs-doctag,.hljs-keyword,.hljs-meta .hljs-keyword,.hljs-template-tag,.hljs-template-variable,.hljs-type,.hljs-variable.language_{color:#ff7b72}.hljs-title,.hljs-title.class_,.hljs-title.class_.inherited__,.hljs-title.function_{color:#d2a8ff}.hljs-attr,.hljs-attribute,.hljs-literal,.hljs-meta,.hljs-number,.hljs-operator,.hljs-selector-attr,.hljs-selector-class,.hljs-selector-id,.hljs-variable{color:#79c0ff}.hljs-meta .hljs-string,.hljs-regexp,.hljs-string{color:#a5d6ff}.hljs-built_in,.hljs-symbol{color:#ffa657}.hljs-code,.hljs-comment,.hljs-formula{color:#8b949e}.hljs-name,.hljs-quote,.hljs-selector-pseudo,.hljs-selector-tag{color:#7ee787}.hljs-subst{color:#c9d1d9}.hljs-section{color:#1f6feb;font-weight:700}.hljs-bullet{color:#f2cc60}.hljs-emphasis{color:#c9d1d9;font-style:italic}.hljs-strong{color:#c9d1d9;font-weight:700}.hljs-addition{color:#aff5b4}.hljs-deletion{color:#ffdcd7}"
        case .google:
            /*
             Theme: Google Dark
             Author: Seth Wright (http://sethawright.com)
             License: ~ MIT (or more permissive) [via base16-schemes-source]
             Maintainer: @highlightjs/core-team
             Version: 2021.09.0
             */
            return "pre code.hljs{display:block;overflow-x:auto;padding:1em}code.hljs{padding:3px 5px}.hljs{color:#c5c8c6}.hljs ::selection,.hljs::selection{color:#c5c8c6}.hljs-comment{color:#969896}.hljs-tag{color:#b4b7b4}.hljs-operator,.hljs-punctuation,.hljs-subst{color:#c5c8c6}.hljs-operator{opacity:.7}.hljs-bullet,.hljs-deletion,.hljs-name,.hljs-selector-tag,.hljs-template-variable,.hljs-variable{color:#cc342b}.hljs-attr,.hljs-link,.hljs-literal,.hljs-number,.hljs-symbol,.hljs-variable.constant_{color:#f96a38}.hljs-class .hljs-title,.hljs-title,.hljs-title.class_{color:#fba922}.hljs-strong{font-weight:700;color:#fba922}.hljs-addition,.hljs-code,.hljs-string,.hljs-title.class_.inherited__{color:#198844}.hljs-attribute,.hljs-built_in,.hljs-doctag,.hljs-function .hljs-title,.hljs-keyword.hljs-atrule,.hljs-quote,.hljs-regexp,.hljs-section,.hljs-title.function_,.ruby .hljs-property{color:#3971ed}.diff .hljs-meta,.hljs-keyword,.hljs-template-tag,.hljs-type{color:#a36ac7}.hljs-emphasis{color:#a36ac7;font-style:italic}.hljs-meta,.hljs-meta .hljs-keyword,.hljs-meta .hljs-string{color:#3971ed}.hljs-meta .hljs-keyword,.hljs-meta-keyword{font-weight:700}"
        case .gradient:
            return "pre code.hljs{display:block;overflow-x:auto;padding:1em}code.hljs{padding:3px 5px}.hljs{color:#e7e4eb}.hljs-subtr{color:#e7e4eb}.hljs-comment,.hljs-doctag,.hljs-meta,.hljs-quote{color:#af8dd9}.hljs-attr,.hljs-regexp,.hljs-selector-id,.hljs-selector-tag,.hljs-tag,.hljs-template-tag{color:#aefbff}.hljs-bullet,.hljs-params,.hljs-selector-class{color:#f19fff}.hljs-keyword,.hljs-meta .hljs-keyword,.hljs-section,.hljs-symbol,.hljs-type{color:#17fc95}.hljs-addition,.hljs-link,.hljs-number{color:#c5fe00}.hljs-string{color:#38c0ff}.hljs-addition,.hljs-attribute{color:#e7ff9f}.hljs-template-variable,.hljs-variable{color:#e447ff}.hljs-built_in,.hljs-class,.hljs-formula,.hljs-function,.hljs-name,.hljs-title{color:#ffc800}.hljs-deletion,.hljs-literal,.hljs-selector-pseudo{color:#ff9e44}.hljs-emphasis,.hljs-quote{font-style:italic}.hljs-keyword,.hljs-params,.hljs-section,.hljs-selector-class,.hljs-selector-id,.hljs-selector-tag,.hljs-strong,.hljs-template-tag{font-weight:700}"
        case .grayscale:
            /*
             Theme: Grayscale Dark
             Author: Alexandre Gavioli (https://github.com/Alexx2/)
             License: ~ MIT (or more permissive) [via base16-schemes-source]
             Maintainer: @highlightjs/core-team
             Version: 2021.09.0
             */
            return "pre code.hljs{display:block;overflow-x:auto;padding:1em}code.hljs{padding:3px 5px}.hljs{color:#b9b9b9}.hljs ::selection,.hljs::selection{color:#b9b9b9}.hljs-comment{color:#525252}.hljs-tag{color:#ababab}.hljs-operator,.hljs-punctuation,.hljs-subst{color:#b9b9b9}.hljs-operator{opacity:.7}.hljs-bullet,.hljs-deletion,.hljs-name,.hljs-selector-tag,.hljs-template-variable,.hljs-variable{color:#7c7c7c}.hljs-attr,.hljs-link,.hljs-literal,.hljs-number,.hljs-symbol,.hljs-variable.constant_{color:#999}.hljs-class .hljs-title,.hljs-title,.hljs-title.class_{color:#a0a0a0}.hljs-strong{font-weight:700;color:#a0a0a0}.hljs-addition,.hljs-code,.hljs-string,.hljs-title.class_.inherited__{color:#8e8e8e}.hljs-built_in,.hljs-doctag,.hljs-keyword.hljs-atrule,.hljs-quote,.hljs-regexp{color:#868686}.hljs-attribute,.hljs-function .hljs-title,.hljs-section,.hljs-title.function_,.ruby .hljs-property{color:#686868}.diff .hljs-meta,.hljs-keyword,.hljs-template-tag,.hljs-type{color:#747474}.hljs-emphasis{color:#747474;font-style:italic}.hljs-meta,.hljs-meta .hljs-keyword,.hljs-meta .hljs-string{color:#5e5e5e}.hljs-meta .hljs-keyword,.hljs-meta-keyword{font-weight:700}"
        case .harmonic16:
            /*
             Theme: Harmonic16 Dark
             Author: Jannik Siebert (https://github.com/janniks)
             License: ~ MIT (or more permissive) [via base16-schemes-source]
             Maintainer: @highlightjs/core-team
             Version: 2021.09.0
             */
            return "pre code.hljs{display:block;overflow-x:auto;padding:1em}code.hljs{padding:3px 5px}.hljs{color:#cbd6e2}.hljs ::selection,.hljs::selection{color:#cbd6e2}.hljs-comment{color:#627e99}.hljs-tag{color:#aabcce}.hljs-operator,.hljs-punctuation,.hljs-subst{color:#cbd6e2}.hljs-operator{opacity:.7}.hljs-bullet,.hljs-deletion,.hljs-name,.hljs-selector-tag,.hljs-template-variable,.hljs-variable{color:#bf8b56}.hljs-attr,.hljs-link,.hljs-literal,.hljs-number,.hljs-symbol,.hljs-variable.constant_{color:#bfbf56}.hljs-class .hljs-title,.hljs-title,.hljs-title.class_{color:#8bbf56}.hljs-strong{font-weight:700;color:#8bbf56}.hljs-addition,.hljs-code,.hljs-string,.hljs-title.class_.inherited__{color:#56bf8b}.hljs-built_in,.hljs-doctag,.hljs-keyword.hljs-atrule,.hljs-quote,.hljs-regexp{color:#568bbf}.hljs-attribute,.hljs-function .hljs-title,.hljs-section,.hljs-title.function_,.ruby .hljs-property{color:#8b56bf}.diff .hljs-meta,.hljs-keyword,.hljs-template-tag,.hljs-type{color:#bf568b}.hljs-emphasis{color:#bf568b;font-style:italic}.hljs-meta,.hljs-meta .hljs-keyword,.hljs-meta .hljs-string{color:#bf5656}.hljs-meta .hljs-keyword,.hljs-meta-keyword{font-weight:700}"
        case .heetch:
            /*
             Theme: Heetch Dark
             Author: Geoffrey Teale (tealeg@gmail.com)
             License: ~ MIT (or more permissive) [via base16-schemes-source]
             Maintainer: @highlightjs/core-team
             Version: 2021.09.0
             */
            return "pre code.hljs{display:block;overflow-x:auto;padding:1em}code.hljs{padding:3px 5px}.hljs{color:#bdb6c5}.hljs ::selection,.hljs::selection{color:#bdb6c5}.hljs-comment{color:#7b6d8b}.hljs-tag{color:#9c92a8}.hljs-operator,.hljs-punctuation,.hljs-subst{color:#bdb6c5}.hljs-operator{opacity:.7}.hljs-bullet,.hljs-deletion,.hljs-name,.hljs-selector-tag,.hljs-template-variable,.hljs-variable{color:#27d9d5}.hljs-attr,.hljs-link,.hljs-literal,.hljs-number,.hljs-symbol,.hljs-variable.constant_{color:#5ba2b6}.hljs-class .hljs-title,.hljs-title,.hljs-title.class_{color:#8f6c97}.hljs-strong{font-weight:700;color:#8f6c97}.hljs-addition,.hljs-code,.hljs-string,.hljs-title.class_.inherited__{color:#c33678}.hljs-built_in,.hljs-doctag,.hljs-keyword.hljs-atrule,.hljs-quote,.hljs-regexp{color:#f80059}.hljs-attribute,.hljs-function .hljs-title,.hljs-section,.hljs-title.function_,.ruby .hljs-property{color:#bd0152}.diff .hljs-meta,.hljs-keyword,.hljs-template-tag,.hljs-type{color:#82034c}.hljs-emphasis{color:#82034c;font-style:italic}.hljs-meta,.hljs-meta .hljs-keyword,.hljs-meta .hljs-string{color:#470546}.hljs-meta .hljs-keyword,.hljs-meta-keyword{font-weight:700}"
        case .horizon:
            /*
             Theme: Horizon Dark
             Author: Michaël Ball (http://github.com/michael-ball/)
             License: ~ MIT (or more permissive) [via base16-schemes-source]
             Maintainer: @highlightjs/core-team
             Version: 2021.09.0
             */
            return "pre code.hljs{display:block;overflow-x:auto;padding:1em}code.hljs{padding:3px 5px}.hljs{color:#cbced0}.hljs ::selection,.hljs::selection{color:#cbced0}.hljs-comment{color:#6f6f70}.hljs-tag{color:#9da0a2}.hljs-operator,.hljs-punctuation,.hljs-subst{color:#cbced0}.hljs-operator{opacity:.7}.hljs-bullet,.hljs-deletion,.hljs-name,.hljs-selector-tag,.hljs-template-variable,.hljs-variable{color:#e93c58}.hljs-attr,.hljs-link,.hljs-literal,.hljs-number,.hljs-symbol,.hljs-variable.constant_{color:#e58d7d}.hljs-class .hljs-title,.hljs-title,.hljs-title.class_{color:#efb993}.hljs-strong{font-weight:700;color:#efb993}.hljs-addition,.hljs-code,.hljs-string,.hljs-title.class_.inherited__{color:#efaf8e}.hljs-built_in,.hljs-doctag,.hljs-keyword.hljs-atrule,.hljs-quote,.hljs-regexp{color:#24a8b4}.hljs-attribute,.hljs-function .hljs-title,.hljs-section,.hljs-title.function_,.ruby .hljs-property{color:#df5273}.diff .hljs-meta,.hljs-keyword,.hljs-template-tag,.hljs-type{color:#b072d1}.hljs-emphasis{color:#b072d1;font-style:italic}.hljs-meta,.hljs-meta .hljs-keyword,.hljs-meta .hljs-string{color:#e4a382}.hljs-meta .hljs-keyword,.hljs-meta-keyword{font-weight:700}"
        case .humanoid:
            /*
             Theme: Humanoid dark
             Author: Thomas (tasmo) Friese
             License: ~ MIT (or more permissive) [via base16-schemes-source]
             Maintainer: @highlightjs/core-team
             Version: 2021.09.0
             */
            return "pre code.hljs{display:block;overflow-x:auto;padding:1em}code.hljs{padding:3px 5px}.hljs{color:#f8f8f2}.hljs ::selection,.hljs::selection{color:#f8f8f2}.hljs-comment{color:#60615d}.hljs-tag{color:#c0c0bd}.hljs-operator,.hljs-punctuation,.hljs-subst{color:#f8f8f2}.hljs-operator{opacity:.7}.hljs-bullet,.hljs-deletion,.hljs-name,.hljs-selector-tag,.hljs-template-variable,.hljs-variable{color:#f11235}.hljs-attr,.hljs-link,.hljs-literal,.hljs-number,.hljs-symbol,.hljs-variable.constant_{color:#ff9505}.hljs-class .hljs-title,.hljs-title,.hljs-title.class_{color:#ffb627}.hljs-strong{font-weight:700;color:#ffb627}.hljs-addition,.hljs-code,.hljs-string,.hljs-title.class_.inherited__{color:#02d849}.hljs-built_in,.hljs-doctag,.hljs-keyword.hljs-atrule,.hljs-quote,.hljs-regexp{color:#0dd9d6}.hljs-attribute,.hljs-function .hljs-title,.hljs-section,.hljs-title.function_,.ruby .hljs-property{color:#00a6fb}.diff .hljs-meta,.hljs-keyword,.hljs-template-tag,.hljs-type{color:#f15ee3}.hljs-emphasis{color:#f15ee3;font-style:italic}.hljs-meta,.hljs-meta .hljs-keyword,.hljs-meta .hljs-string{color:#b27701}.hljs-meta .hljs-keyword,.hljs-meta-keyword{font-weight:700}"
        case .ia:
            /*
             Theme: iA Dark
             Author: iA Inc. (modified by aramisgithub)
             License: ~ MIT (or more permissive) [via base16-schemes-source]
             Maintainer: @highlightjs/core-team
             Version: 2021.09.0
             */
            return "pre code.hljs{display:block;overflow-x:auto;padding:1em}code.hljs{padding:3px 5px}.hljs{color:#ccc}.hljs ::selection,.hljs::selection{color:#ccc}.hljs-comment{color:#767676}.hljs-tag{color:#b8b8b8}.hljs-operator,.hljs-punctuation,.hljs-subst{color:#ccc}.hljs-operator{opacity:.7}.hljs-bullet,.hljs-deletion,.hljs-name,.hljs-selector-tag,.hljs-template-variable,.hljs-variable{color:#d88568}.hljs-attr,.hljs-link,.hljs-literal,.hljs-number,.hljs-symbol,.hljs-variable.constant_{color:#d86868}.hljs-class .hljs-title,.hljs-title,.hljs-title.class_{color:#b99353}.hljs-strong{font-weight:700;color:#b99353}.hljs-addition,.hljs-code,.hljs-string,.hljs-title.class_.inherited__{color:#83a471}.hljs-built_in,.hljs-doctag,.hljs-keyword.hljs-atrule,.hljs-quote,.hljs-regexp{color:#7c9cae}.hljs-attribute,.hljs-function .hljs-title,.hljs-section,.hljs-title.function_,.ruby .hljs-property{color:#8eccdd}.diff .hljs-meta,.hljs-keyword,.hljs-template-tag,.hljs-type{color:#b98eb2}.hljs-emphasis{color:#b98eb2;font-style:italic}.hljs-meta,.hljs-meta .hljs-keyword,.hljs-meta .hljs-string{color:#8b6c37}.hljs-meta .hljs-keyword,.hljs-meta-keyword{font-weight:700}"
        case .isblEditor:
            return "pre code.hljs{display:block;overflow-x:auto;padding:1em}code.hljs{padding:3px 5px}.hljs,.hljs-subst{color:#f0f0f0}.hljs-comment{color:#b5b5b5;font-style:italic}.hljs-attribute,.hljs-doctag,.hljs-keyword,.hljs-meta .hljs-keyword,.hljs-name,.hljs-selector-tag{color:#f0f0f0;font-weight:700}.hljs-string{color:#97bf0d}.hljs-deletion,.hljs-number,.hljs-quote,.hljs-selector-class,.hljs-selector-id,.hljs-template-tag,.hljs-type{color:#f0f0f0}.hljs-link,.hljs-regexp,.hljs-selector-attr,.hljs-selector-pseudo,.hljs-symbol,.hljs-template-variable,.hljs-variable{color:#e2c696}.hljs-built_in,.hljs-literal{color:#97bf0d;font-weight:700}.hljs-addition,.hljs-bullet,.hljs-code{color:#397300}.hljs-class{color:#ce9d4d;font-weight:700}.hljs-section,.hljs-title{color:#df471e}.hljs-title>.hljs-built_in{color:#81bce9;font-weight:400}.hljs-meta{color:#1f7199}.hljs-meta .hljs-string{color:#4d99bf}.hljs-emphasis{font-style:italic}.hljs-strong{font-weight:700}"
        case .kimbie:
            return "pre code.hljs{display:block;overflow-x:auto;padding:1em}code.hljs{padding:3px 5px}.hljs{color:#d3af86}.hljs-comment,.hljs-quote{color:#d6baad}.hljs-meta,.hljs-name,.hljs-regexp,.hljs-selector-class,.hljs-selector-id,.hljs-tag,.hljs-template-variable,.hljs-variable{color:#dc3958}.hljs-built_in,.hljs-deletion,.hljs-link,.hljs-literal,.hljs-number,.hljs-params,.hljs-type{color:#f79a32}.hljs-addition,.hljs-bullet,.hljs-string,.hljs-symbol{color:#889b4a}.hljs-function,.hljs-keyword,.hljs-selector-tag{color:#98676a}.hljs-attribute,.hljs-section,.hljs-title{color:#f06431}.hljs-emphasis{font-style:italic}.hljs-strong{font-weight:700}"
        case .nnfx:
            /*
             Theme: nnfx dark
             Description: a theme inspired by Netscape Navigator/Firefox
             Author: (c) 2020-2021 Jim Mason <jmason@ibinx.com>
             Maintainer: @RocketMan
             License: https://creativecommons.org/licenses/by-sa/4.0  CC BY-SA 4.0
             Updated: 2021-05-17

             @version 1.1.0
             */
            return "pre code.hljs{display:block;overflow-x:auto;padding:1em}code.hljs{padding:3px 5px}.hljs{color:#fff}.language-xml .hljs-meta,.language-xml .hljs-meta-string{font-weight:700;font-style:italic;color:#69f}.hljs-comment,.hljs-quote{font-style:italic;color:#9c6}.hljs-built_in,.hljs-keyword,.hljs-name{color:#a7a}.hljs-attr,.hljs-name{font-weight:700}.hljs-string{font-weight:400}.hljs-code,.hljs-link,.hljs-meta .hljs-string,.hljs-number,.hljs-regexp,.hljs-string{color:#bce}.hljs-bullet,.hljs-symbol,.hljs-template-variable,.hljs-title,.hljs-variable{color:#d40}.hljs-class .hljs-title,.hljs-title.class_,.hljs-type{font-weight:700;color:#96c}.hljs-attr,.hljs-function .hljs-title,.hljs-subst,.hljs-tag,.hljs-title.function_{color:#fff}.hljs-formula{font-style:italic}.hljs-meta{color:#69f}.hljs-section,.hljs-selector-class,.hljs-selector-id,.hljs-selector-pseudo,.hljs-selector-tag{font-weight:700;color:#69f}.hljs-selector-pseudo{font-style:italic}.hljs-doctag,.hljs-strong{font-weight:700}.hljs-emphasis{font-style:italic}"
        case .pandaSyntax:
            return "pre code.hljs{display:block;overflow-x:auto;padding:1em}code.hljs{padding:3px 5px}.hljs{color:#e6e6e6}.hljs-emphasis{font-style:italic}.hljs-strong{font-weight:700}.hljs-link{text-decoration:underline}.hljs-comment,.hljs-quote{color:#bbb;font-style:italic}.hljs-params{color:#bbb}.hljs-attr,.hljs-punctuation{color:#e6e6e6}.hljs-meta,.hljs-name,.hljs-selector-tag{color:#ff4b82}.hljs-char.escape_,.hljs-operator{color:#b084eb}.hljs-deletion,.hljs-keyword{color:#ff75b5}.hljs-regexp,.hljs-selector-attr,.hljs-selector-pseudo,.hljs-variable.language_{color:#ff9ac1}.hljs-code,.hljs-formula,.hljs-property,.hljs-section,.hljs-subst,.hljs-title.function_{color:#45a9f9}.hljs-addition,.hljs-bullet,.hljs-meta .hljs-string,.hljs-selector-class,.hljs-string,.hljs-symbol,.hljs-title.class_,.hljs-title.class_.inherited__{color:#19f9d8}.hljs-attribute,.hljs-built_in,.hljs-doctag,.hljs-link,.hljs-literal,.hljs-meta .hljs-keyword,.hljs-number,.hljs-punctuation,.hljs-selector-id,.hljs-tag,.hljs-template-tag,.hljs-template-variable,.hljs-title,.hljs-type,.hljs-variable{color:#ffb86c}"
        case .papercolor:
            /*
             Theme: PaperColor Dark
             Author: Jon Leopard (http://github.com/jonleopard) based on PaperColor Theme (https://github.com/NLKNguyen/papercolor-theme)
             License: ~ MIT (or more permissive) [via base16-schemes-source]
             Maintainer: @highlightjs/core-team
             Version: 2021.09.0
             */
            return "pre code.hljs{display:block;overflow-x:auto;padding:1em}code.hljs{padding:3px 5px}.hljs{color:grey}.hljs ::selection,.hljs::selection{color:grey}.hljs-comment{color:#d7af5f}.hljs-tag{color:#5fafd7}.hljs-operator,.hljs-punctuation,.hljs-subst{color:grey}.hljs-operator{opacity:.7}.hljs-bullet,.hljs-deletion,.hljs-name,.hljs-selector-tag,.hljs-template-variable,.hljs-variable{color:#585858}.hljs-attr,.hljs-link,.hljs-literal,.hljs-number,.hljs-symbol,.hljs-variable.constant_{color:#5faf5f}.hljs-class .hljs-title,.hljs-title,.hljs-title.class_{color:#afd700}.hljs-strong{font-weight:700;color:#afd700}.hljs-addition,.hljs-code,.hljs-string,.hljs-title.class_.inherited__{color:#af87d7}.hljs-built_in,.hljs-doctag,.hljs-keyword.hljs-atrule,.hljs-quote,.hljs-regexp{color:#ffaf00}.hljs-attribute,.hljs-function .hljs-title,.hljs-section,.hljs-title.function_,.ruby .hljs-property{color:#ff5faf}.diff .hljs-meta,.hljs-keyword,.hljs-template-tag,.hljs-type{color:#00afaf}.hljs-emphasis{color:#00afaf;font-style:italic}.hljs-meta,.hljs-meta .hljs-keyword,.hljs-meta .hljs-string{color:#5f8787}.hljs-meta .hljs-keyword,.hljs-meta-keyword{font-weight:700}"
        case .paraiso:
            return "pre code.hljs{display:block;overflow-x:auto;padding:1em}code.hljs{padding:3px 5px}.hljs{color:#a39e9b}.hljs-comment,.hljs-quote{color:#8d8687}.hljs-link,.hljs-meta,.hljs-name,.hljs-regexp,.hljs-selector-class,.hljs-selector-id,.hljs-tag,.hljs-template-variable,.hljs-variable{color:#ef6155}.hljs-built_in,.hljs-deletion,.hljs-literal,.hljs-number,.hljs-params,.hljs-type{color:#f99b15}.hljs-attribute,.hljs-section,.hljs-title{color:#fec418}.hljs-addition,.hljs-bullet,.hljs-string,.hljs-symbol{color:#48b685}.hljs-keyword,.hljs-selector-tag{color:#815ba4}.hljs-emphasis{font-style:italic}.hljs-strong{font-weight:700}"
        case .qtcreator:
            return "pre code.hljs{display:block;overflow-x:auto;padding:1em}code.hljs{padding:3px 5px}.hljs{color:#aaa}.hljs-emphasis,.hljs-strong{color:#a8a8a2}.hljs-bullet,.hljs-literal,.hljs-number,.hljs-quote,.hljs-regexp{color:#f5f}.hljs-code .hljs-selector-class{color:#aaf}.hljs-emphasis,.hljs-stronge,.hljs-type{font-style:italic}.hljs-function,.hljs-keyword,.hljs-name,.hljs-section,.hljs-selector-tag,.hljs-symbol{color:#ff5}.hljs-subst,.hljs-tag,.hljs-title{color:#aaa}.hljs-attribute{color:#f55}.hljs-class .hljs-title,.hljs-params,.hljs-title.class_,.hljs-variable{color:#88f}.hljs-addition,.hljs-built_in,.hljs-link,.hljs-selector-attr,.hljs-selector-id,.hljs-selector-pseudo,.hljs-string,.hljs-template-tag,.hljs-template-variable,.hljs-type{color:#f5f}.hljs-comment,.hljs-deletion,.hljs-meta{color:#5ff}"
        case .silk:
            /*
             Theme: Silk Dark
             Author: Gabriel Fontes (https://github.com/Misterio77)
             License: ~ MIT (or more permissive) [via base16-schemes-source]
             Maintainer: @highlightjs/core-team
             Version: 2021.09.0
             */
            return "pre code.hljs{display:block;overflow-x:auto;padding:1em}code.hljs{padding:3px 5px}.hljs{color:#c7dbdd}.hljs ::selection,.hljs::selection{color:#c7dbdd}.hljs-comment{color:#587073}.hljs-tag{color:#9dc8cd}.hljs-operator,.hljs-punctuation,.hljs-subst{color:#c7dbdd}.hljs-operator{opacity:.7}.hljs-bullet,.hljs-deletion,.hljs-name,.hljs-selector-tag,.hljs-template-variable,.hljs-variable{color:#fb6953}.hljs-attr,.hljs-link,.hljs-literal,.hljs-number,.hljs-symbol,.hljs-variable.constant_{color:#fcab74}.hljs-class .hljs-title,.hljs-title,.hljs-title.class_{color:#fce380}.hljs-strong{font-weight:700;color:#fce380}.hljs-addition,.hljs-code,.hljs-string,.hljs-title.class_.inherited__{color:#73d8ad}.hljs-built_in,.hljs-doctag,.hljs-keyword.hljs-atrule,.hljs-quote,.hljs-regexp{color:#3fb2b9}.hljs-attribute,.hljs-function .hljs-title,.hljs-section,.hljs-title.function_,.ruby .hljs-property{color:#46bddd}.diff .hljs-meta,.hljs-keyword,.hljs-template-tag,.hljs-type{color:#756b8a}.hljs-emphasis{color:#756b8a;font-style:italic}.hljs-meta,.hljs-meta .hljs-keyword,.hljs-meta .hljs-string{color:#9b647b}.hljs-meta .hljs-keyword,.hljs-meta-keyword{font-weight:700}"
        case .solarFlare:
            /*
             Theme: Solar Flare
             Author: Chuck Harmston (https://chuck.harmston.ch)
             License: ~ MIT (or more permissive) [via base16-schemes-source]
             Maintainer: @highlightjs/core-team
             Version: 2021.09.0
             */
            return "pre code.hljs{display:block;overflow-x:auto;padding:1em}code.hljs{padding:3px 5px}.hljs{color:#a6afb8}.hljs ::selection,.hljs::selection{color:#a6afb8}.hljs-comment{color:#667581}.hljs-tag{color:#85939e}.hljs-operator,.hljs-punctuation,.hljs-subst{color:#a6afb8}.hljs-operator{opacity:.7}.hljs-bullet,.hljs-deletion,.hljs-name,.hljs-selector-tag,.hljs-template-variable,.hljs-variable{color:#ef5253}.hljs-attr,.hljs-link,.hljs-literal,.hljs-number,.hljs-symbol,.hljs-variable.constant_{color:#e66b2b}.hljs-class .hljs-title,.hljs-title,.hljs-title.class_{color:#e4b51c}.hljs-strong{font-weight:700;color:#e4b51c}.hljs-addition,.hljs-code,.hljs-string,.hljs-title.class_.inherited__{color:#7cc844}.hljs-built_in,.hljs-doctag,.hljs-keyword.hljs-atrule,.hljs-quote,.hljs-regexp{color:#52cbb0}.hljs-attribute,.hljs-function .hljs-title,.hljs-section,.hljs-title.function_,.ruby .hljs-property{color:#33b5e1}.diff .hljs-meta,.hljs-keyword,.hljs-template-tag,.hljs-type{color:#a363d5}.hljs-emphasis{color:#a363d5;font-style:italic}.hljs-meta,.hljs-meta .hljs-keyword,.hljs-meta .hljs-string{color:#d73c9a}.hljs-meta .hljs-keyword,.hljs-meta-keyword{font-weight:700}"
        case .solarized:
            /*
             Theme: Solarized Dark
             Author: Ethan Schoonover (modified by aramisgithub)
             License: ~ MIT (or more permissive) [via base16-schemes-source]
             Maintainer: @highlightjs/core-team
             Version: 2021.09.0
             */
            return "pre code.hljs{display:block;overflow-x:auto;padding:1em}code.hljs{padding:3px 5px}.hljs{color:#93a1a1}.hljs ::selection,.hljs::selection{color:#93a1a1}.hljs-comment{color:#657b83}.hljs-tag{color:#839496}.hljs-operator,.hljs-punctuation,.hljs-subst{color:#93a1a1}.hljs-operator{opacity:.7}.hljs-bullet,.hljs-deletion,.hljs-name,.hljs-selector-tag,.hljs-template-variable,.hljs-variable{color:#dc322f}.hljs-attr,.hljs-link,.hljs-literal,.hljs-number,.hljs-symbol,.hljs-variable.constant_{color:#cb4b16}.hljs-class .hljs-title,.hljs-title,.hljs-title.class_{color:#b58900}.hljs-strong{font-weight:700;color:#b58900}.hljs-addition,.hljs-code,.hljs-string,.hljs-title.class_.inherited__{color:#859900}.hljs-built_in,.hljs-doctag,.hljs-keyword.hljs-atrule,.hljs-quote,.hljs-regexp{color:#2aa198}.hljs-attribute,.hljs-function .hljs-title,.hljs-section,.hljs-title.function_,.ruby .hljs-property{color:#268bd2}.diff .hljs-meta,.hljs-keyword,.hljs-template-tag,.hljs-type{color:#6c71c4}.hljs-emphasis{color:#6c71c4;font-style:italic}.hljs-meta,.hljs-meta .hljs-keyword,.hljs-meta .hljs-string{color:#d33682}.hljs-meta .hljs-keyword,.hljs-meta-keyword{font-weight:700}"
        case .stackoverflow:
            /*
             Theme: StackOverflow Dark
             Description: Dark theme as used on stackoverflow.com
             Author: stackoverflow.com
             Maintainer: @Hirse
             Website: https://github.com/StackExchange/Stacks
             License: MIT
             Updated: 2021-05-15

             Updated for @stackoverflow/stacks v0.64.0
             Code Blocks: /blob/v0.64.0/lib/css/components/_stacks-code-blocks.less
             Colors: /blob/v0.64.0/lib/css/exports/_stacks-constants-colors.less
             */
            return "pre code.hljs{display:block;overflow-x:auto;padding:1em}code.hljs{padding:3px 5px}.hljs{color:#fff}.hljs-subst{color:#fff}.hljs-comment{color:#999}.hljs-attr,.hljs-doctag,.hljs-keyword,.hljs-meta .hljs-keyword,.hljs-section,.hljs-selector-tag{color:#88aece}.hljs-attribute{color:#c59bc1}.hljs-name,.hljs-number,.hljs-quote,.hljs-selector-id,.hljs-template-tag,.hljs-type{color:#f08d49}.hljs-selector-class{color:#88aece}.hljs-link,.hljs-regexp,.hljs-selector-attr,.hljs-string,.hljs-symbol,.hljs-template-variable,.hljs-variable{color:#b5bd68}.hljs-meta,.hljs-selector-pseudo{color:#88aece}.hljs-built_in,.hljs-literal,.hljs-title{color:#f08d49}.hljs-bullet,.hljs-code{color:#ccc}.hljs-meta .hljs-string{color:#b5bd68}.hljs-deletion{color:#de7176}.hljs-addition{color:#76c490}.hljs-emphasis{font-style:italic}.hljs-strong{font-weight:700}"
        case .standard:
            /*
             Theme: Default Dark
             Author: Chris Kempson (http://chriskempson.com)
             License: ~ MIT (or more permissive) [via base16-schemes-source]
             Maintainer: @highlightjs/core-team
             Version: 2021.09.0
             */
            return "pre code.hljs{display:block;overflow-x:auto;padding:1em}code.hljs{padding:3px 5px}.hljs{color:#d8d8d8}.hljs ::selection,.hljs::selection{color:#d8d8d8}.hljs-comment{color:#585858}.hljs-tag{color:#b8b8b8}.hljs-operator,.hljs-punctuation,.hljs-subst{color:#d8d8d8}.hljs-operator{opacity:.7}.hljs-bullet,.hljs-deletion,.hljs-name,.hljs-selector-tag,.hljs-template-variable,.hljs-variable{color:#ab4642}.hljs-attr,.hljs-link,.hljs-literal,.hljs-number,.hljs-symbol,.hljs-variable.constant_{color:#dc9656}.hljs-class .hljs-title,.hljs-title,.hljs-title.class_{color:#f7ca88}.hljs-strong{font-weight:700;color:#f7ca88}.hljs-addition,.hljs-code,.hljs-string,.hljs-title.class_.inherited__{color:#a1b56c}.hljs-built_in,.hljs-doctag,.hljs-keyword.hljs-atrule,.hljs-quote,.hljs-regexp{color:#86c1b9}.hljs-attribute,.hljs-function .hljs-title,.hljs-section,.hljs-title.function_,.ruby .hljs-property{color:#7cafc2}.diff .hljs-meta,.hljs-keyword,.hljs-template-tag,.hljs-type{color:#ba8baf}.hljs-emphasis{color:#ba8baf;font-style:italic}.hljs-meta,.hljs-meta .hljs-keyword,.hljs-meta .hljs-string{color:#a16946}.hljs-meta .hljs-keyword,.hljs-meta-keyword{font-weight:700}"
        case .summerfruit:
            /*
             Theme: Summerfruit Dark
             Author: Christopher Corley (http://christop.club/)
             License: ~ MIT (or more permissive) [via base16-schemes-source]
             Maintainer: @highlightjs/core-team
             Version: 2021.09.0
             */
            return "pre code.hljs{display:block;overflow-x:auto;padding:1em}code.hljs{padding:3px 5px}.hljs{color:#d0d0d0}.hljs ::selection,.hljs::selection{color:#d0d0d0}.hljs-comment{color:#505050}.hljs-tag{color:#b0b0b0}.hljs-operator,.hljs-punctuation,.hljs-subst{color:#d0d0d0}.hljs-operator{opacity:.7}.hljs-bullet,.hljs-deletion,.hljs-name,.hljs-selector-tag,.hljs-template-variable,.hljs-variable{color:#ff0086}.hljs-attr,.hljs-link,.hljs-literal,.hljs-number,.hljs-symbol,.hljs-variable.constant_{color:#fd8900}.hljs-class .hljs-title,.hljs-title,.hljs-title.class_{color:#aba800}.hljs-strong{font-weight:700;color:#aba800}.hljs-addition,.hljs-code,.hljs-string,.hljs-title.class_.inherited__{color:#00c918}.hljs-built_in,.hljs-doctag,.hljs-keyword.hljs-atrule,.hljs-quote,.hljs-regexp{color:#1faaaa}.hljs-attribute,.hljs-function .hljs-title,.hljs-section,.hljs-title.function_,.ruby .hljs-property{color:#3777e6}.diff .hljs-meta,.hljs-keyword,.hljs-template-tag,.hljs-type{color:#ad00a1}.hljs-emphasis{color:#ad00a1;font-style:italic}.hljs-meta,.hljs-meta .hljs-keyword,.hljs-meta .hljs-string{color:#c63}.hljs-meta .hljs-keyword,.hljs-meta-keyword{font-weight:700}"
        case .synthMidnightTerminal:
            /*
             Theme: Synth Midnight Terminal Dark
             Author: Michaël Ball (http://github.com/michael-ball/)
             License: ~ MIT (or more permissive) [via base16-schemes-source]
             Maintainer: @highlightjs/core-team
             Version: 2021.09.0
             */
            return "pre code.hljs{display:block;overflow-x:auto;padding:1em}code.hljs{padding:3px 5px}.hljs{color:#c1c3c4}.hljs ::selection,.hljs::selection{color:#c1c3c4}.hljs-comment{color:#474849}.hljs-tag{color:#a3a5a6}.hljs-operator,.hljs-punctuation,.hljs-subst{color:#c1c3c4}.hljs-operator{opacity:.7}.hljs-bullet,.hljs-deletion,.hljs-name,.hljs-selector-tag,.hljs-template-variable,.hljs-variable{color:#b53b50}.hljs-attr,.hljs-link,.hljs-literal,.hljs-number,.hljs-symbol,.hljs-variable.constant_{color:#ea770d}.hljs-class .hljs-title,.hljs-title,.hljs-title.class_{color:#c9d364}.hljs-strong{font-weight:700;color:#c9d364}.hljs-addition,.hljs-code,.hljs-string,.hljs-title.class_.inherited__{color:#06ea61}.hljs-built_in,.hljs-doctag,.hljs-keyword.hljs-atrule,.hljs-quote,.hljs-regexp{color:#42fff9}.hljs-attribute,.hljs-function .hljs-title,.hljs-section,.hljs-title.function_,.ruby .hljs-property{color:#03aeff}.diff .hljs-meta,.hljs-keyword,.hljs-template-tag,.hljs-type{color:#ea5ce2}.hljs-emphasis{color:#ea5ce2;font-style:italic}.hljs-meta,.hljs-meta .hljs-keyword,.hljs-meta .hljs-string{color:#cd6320}.hljs-meta .hljs-keyword,.hljs-meta-keyword{font-weight:700}"
        case .tokyoNight:
            /*
             Theme: Tokyo-night-Dark
             origin: https://github.com/enkia/tokyo-night-vscode-theme
             Description: Original highlight.js style
             Author: (c) Henri Vandersleyen <hvandersleyen@gmail.com>
             License: see project LICENSE
             Touched: 2022
             */
            return "pre code.hljs{display:block;overflow-x:auto;padding:1em}code.hljs{padding:3px 5px}.hljs-comment,.hljs-meta{color:#565f89}.hljs-deletion,.hljs-doctag,.hljs-regexp,.hljs-selector-attr,.hljs-selector-class,.hljs-selector-id,.hljs-selector-pseudo,.hljs-tag,.hljs-template-tag,.hljs-variable.language_{color:#f7768e}.hljs-link,.hljs-literal,.hljs-number,.hljs-params,.hljs-template-variable,.hljs-type,.hljs-variable{color:#ff9e64}.hljs-attribute,.hljs-built_in{color:#e0af68}.hljs-keyword,.hljs-property,.hljs-subst,.hljs-title,.hljs-title.class_,.hljs-title.class_.inherited__,.hljs-title.function_{color:#7dcfff}.hljs-selector-tag{color:#73daca}.hljs-addition,.hljs-bullet,.hljs-quote,.hljs-string,.hljs-symbol{color:#9ece6a}.hljs-code,.hljs-formula,.hljs-section{color:#7aa2f7}.hljs-attr,.hljs-char.escape_,.hljs-keyword,.hljs-name,.hljs-operator{color:#bb9af7}.hljs-punctuation{color:#c0caf5}.hljs{color:#9aa5ce}.hljs-emphasis{font-style:italic}.hljs-strong{font-weight:700}"
        case .unikitty:
            /*
             Theme: Unikitty Dark
             Author: Josh W Lewis (@joshwlewis)
             License: ~ MIT (or more permissive) [via base16-schemes-source]
             Maintainer: @highlightjs/core-team
             Version: 2021.09.0
             */
            return "pre code.hljs{display:block;overflow-x:auto;padding:1em}code.hljs{padding:3px 5px}.hljs{color:#bcbabe}.hljs ::selection,.hljs::selection{color:#bcbabe}.hljs-comment{color:#838085}.hljs-tag{color:#9f9da2}.hljs-operator,.hljs-punctuation,.hljs-subst{color:#bcbabe}.hljs-operator{opacity:.7}.hljs-bullet,.hljs-deletion,.hljs-name,.hljs-selector-tag,.hljs-template-variable,.hljs-variable{color:#d8137f}.hljs-attr,.hljs-link,.hljs-literal,.hljs-number,.hljs-symbol,.hljs-variable.constant_{color:#d65407}.hljs-class .hljs-title,.hljs-title,.hljs-title.class_{color:#dc8a0e}.hljs-strong{font-weight:700;color:#dc8a0e}.hljs-addition,.hljs-code,.hljs-string,.hljs-title.class_.inherited__{color:#17ad98}.hljs-built_in,.hljs-doctag,.hljs-keyword.hljs-atrule,.hljs-quote,.hljs-regexp{color:#149bda}.hljs-attribute,.hljs-function .hljs-title,.hljs-section,.hljs-title.function_,.ruby .hljs-property{color:#796af5}.diff .hljs-meta,.hljs-keyword,.hljs-template-tag,.hljs-type{color:#bb60ea}.hljs-emphasis{color:#bb60ea;font-style:italic}.hljs-meta,.hljs-meta .hljs-keyword,.hljs-meta .hljs-string{color:#c720ca}.hljs-meta .hljs-keyword,.hljs-meta-keyword{font-weight:700}"
        case .xcode:
            return ".hljs{display:block;overflow-x:auto;padding:0.5em;color:white}.xml .hljs-meta{color:#6C7986}.hljs-comment,.hljs-quote{color:#6C7986}.hljs-tag,.hljs-attribute,.hljs-keyword,.hljs-selector-tag,.hljs-literal,.hljs-name{color:#FC5FA3}.hljs-variable,.hljs-template-variable{color:#FC5FA3}.hljs-code,.hljs-string,.hljs-meta-string{color:#FC6A5D}.hljs-regexp,.hljs-link{color:#5482FF}.hljs-title,.hljs-symbol,.hljs-bullet,.hljs-number{color:#41A1C0}.hljs-section,.hljs-meta{color:#FC5FA3}.hljs-class .hljs-title,.hljs-type,.hljs-built_in,.hljs-builtin-name,.hljs-params{color:#D0A8FF}.hljs-attr{color:#BF8555}.hljs-subst{color:#FFF}.hljs-formula{font-style:italic}.hljs-selector-id,.hljs-selector-class{color:#9b703f}.hljs-doctag,.hljs-strong{font-weight:bold}.hljs-emphasis{font-style:italic}"
        }
    }
}
