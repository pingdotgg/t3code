---
title: "T3 Code is free and MIT licensed"
description: "T3 Code is free and open source under MIT. Learn what the license allows, who builds the app, and why agent access stays separate."
updated: 2026-11-04
sources:
  - label: "T3 Code MIT license and copyright holder"
    url: "https://github.com/pingdotgg/t3code/blob/main/LICENSE"
  - label: "Project purpose and provider setup"
    url: "https://github.com/pingdotgg/t3code/blob/main/README.md"
  - label: "Theo on the free, open source launch, 1:01"
    url: "https://www.youtube.com/watch?v=hDn8-fK3XaU&t=61s"
  - label: "Theo on why T3 Code exists, 12:01"
    url: "https://www.youtube.com/watch?v=hDn8-fK3XaU&t=721s"
  - label: "Theo on funding full-time developers, 1:00"
    url: "https://www.youtube.com/watch?v=RIkSlHgQYog&t=60s"
  - label: "Theo on keeping developer tools customizable, 28:01"
    url: "https://www.youtube.com/watch?v=dLhcLqoff6k&t=1681s"
  - label: "Contribution policy"
    url: "https://github.com/pingdotgg/t3code/blob/main/CONTRIBUTING.md"
faq:
  - question: "Is T3 Code open source?"
    answer: "T3 Code is open source under the MIT license. The official source repository is pingdotgg/t3code on GitHub."
  - question: "Is T3 Code free to use?"
    answer: "T3 Code is free to use. It controls agents configured on your machine, and its MIT license does not supply a paid agent subscription or inference credits."
  - question: "Can I fork T3 Code for commercial use?"
    answer: "T3 Code's MIT license permits modification, distribution, sublicensing, and selling copies. Include the copyright and permission notices in copies or substantial portions of the software."
  - question: "Who makes T3 Code?"
    answer: "T3 Code's license names T3 Tools Inc. as the copyright holder. Theo Browne describes building the application with Julius and funding developers working on it full-time."
---

T3 Code is free and open source under the MIT license. T3 Tools Inc. is the copyright holder, and you can use, modify, and distribute the code under the license's terms.

## What does the MIT license let you do?

The repository's [LICENSE file](https://github.com/pingdotgg/t3code/blob/main/LICENSE) grants broad permission to work with the software. That includes copying it, changing it, combining it with other software, publishing it, and distributing or selling copies.

For a developer, source access means you can investigate behavior and keep your own changes. You can maintain a fork when your needs differ from the upstream application. The README explicitly describes giving people what they need to fork the editor if its direction changes.

| Your goal                       | What the license says                                                            |
| ------------------------------- | -------------------------------------------------------------------------------- |
| Use T3 Code yourself            | Use of the software is permitted without a license fee.                          |
| Change the source               | Modification and merging are permitted.                                          |
| Share or sell a copy            | Distribution, sublicensing, and selling copies are permitted.                    |
| Include code in another project | Copies or substantial portions must retain the copyright and permission notices. |

The license also disclaims warranties and limits the authors' liability. Read its complete text before redistributing code. The permissions summary here does not replace that text.

## Does free T3 Code include free AI usage?

T3 Code provides an interface for agents running through their own runtimes and authentication. The application license gives you rights to T3 Code's code. It does not provide an agent subscription, an account with a model provider, or inference credits.

The README describes T3 Code as a way to use the subscriptions and agents configured on your computer. For example, the [Claude Code guide](/learn/providers/claude-code) and [Codex guide](/learn/providers/codex) cover those integrations. Their account requirements belong to those services.

This distinction answers two different questions. Downloading T3 Code does not require buying a T3 Code license. Running an agent still requires the access that agent supports. Check the agent's setup before treating a missing sign-in as an application licensing problem.

For the wider product explanation, read [what T3 Code is](/learn/start/what-is-t3-code). If you are choosing an installer, follow the [official-download verification guide](/learn/start/verify-official-download) and use [the download page](/download).

## Who builds T3 Code, and why is it free?

The license names T3 Tools Inc. and carries a 2026 copyright notice. In the launch video, Theo Browne describes building T3 Code with Julius because they wanted a different development experience.

At [12:01 in the launch video](https://www.youtube.com/watch?v=hDn8-fK3XaU&t=721s), Theo says: “We built this because we wanted it, not because we want to make money from it.”

In a [later explanation at 1:00](https://www.youtube.com/watch?v=RIkSlHgQYog&t=60s), he says the app makes no money at that point. He also describes funding multiple developers working on it full-time. Those statements explain his funding choice when he recorded the video. They do not promise that every future service will be free.

Theo returns to source access at [28:01 in his video about leaving terminal workflows](https://www.youtube.com/watch?v=dLhcLqoff6k&t=1681s). He describes wanting developers to customize their software as agents become better at changing it. The current README makes the same practical commitment through the ability to fork.

## What should you check before redistributing a fork?

Start with T3 Code's own MIT notice. Then inspect the [third-party licenses](/learn/open-source/third-party-licenses) for included dependencies and adapted assets. The application's root license does not describe every item in its distribution.

If you want to test your changes locally, follow [the source build steps](/learn/open-source/build-from-source). Publishing your own fork and asking maintainers to merge a change are separate decisions. Read [the contribution policy summary](/learn/open-source/contributing) before investing in an upstream PR.

The same separation applies to privacy. MIT describes code permissions, while [product usage data](/learn/safety/product-usage-data) explains a different aspect of using the application.

## Next steps

- Return to the [open source overview](/learn/open-source) for the source guides.
- Check [dependency and asset notices](/learn/open-source/third-party-licenses) before sharing a modified build.
- Watch the [launch explanation](/learn/videos/its-finally-here) for Theo's original description of the project.
