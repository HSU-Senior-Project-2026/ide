# Judge0 IDE
[![Judge0 IDE Screenshot](./.github/screenshot.png)](https://ide.judge0.com)

[![License](https://img.shields.io/github/license/judge0/ide?color=2185d0&style=flat-square)](https://github.com/judge0/ide/blob/master/LICENSE)
[![Release](https://img.shields.io/github/v/release/judge0/ide?color=2185d0&style=flat-square)](https://github.com/judge0/ide/releases)
[![Stars](https://img.shields.io/github/stars/judge0/ide?color=2185d0&style=flat-square)](https://github.com/judge0/ide/stargazers)

<a href="https://www.producthunt.com/posts/judge0-ide" target="_blank"><img src="https://api.producthunt.com/widgets/embed-image/v1/featured.svg?post_id=179885&theme=light" alt="" height="43px" /></a>

## About
[**Judge0 IDE**](https://ide.judge0.com) is a free and open-source online code editor that allows you to write and execute code from a rich set of languages. It's perfect for anybody who just wants to quickly write and run some code without opening a full-featured IDE on their computer. Moreover, it is also useful for teaching and learning or just trying out a new language.

Judge0 IDE is using [**Judge0**](https://ce.judge0.com) for executing the user's source code.

Visit https://ide.judge0.com, and enjoy happy coding. :)

## Community

Join our community - get help, share feedback, and contribute. Whether you're integrating Judge0, building with the API, or reporting bugs, your participation helps improve the project for everyone.

* [Visit Judge0 website](https://judge0.com)
* [Read Judge0 blog](https://blog.judge0.com)
* [Subscribe to Judge0 newsletter](https://newsletter.judge0.com)
* [Join Judge0 Discord server](https://discord.judge0.com)
* [Follow Judge0 on X](https://x.com/Judge0HQ)
* [Follow Judge0 on LinkedIn](https://www.linkedin.com/company/judge0)
* [Read Judge0 research paper](https://paper.judge0.com)
* [Watch Judge0 asciicasts](https://asciinema.org/~hermanzdosilovic)
* [Report an issue](https://github.com/judge0/judge0/issues/new)
* [Contact Judge0 team via email](mailto:contact@judge0.com)
* [Schedule a meeting with Judge0 team](https://meet.judge0.com)

## Author and Contributors
Judge0 IDE was created by [Herman Zvonimir Došilović](https://github.com/hermanzdosilovic).

Thanks a lot to all [contributors](https://github.com/judge0/ide/graphs/contributors) for their contributions to this project.

## License
Judge0 IDE is licensed under the [MIT License](https://github.com/judge0/ide/blob/master/LICENSE).

## Local Judge0 Java Fix
If your local Judge0 Java runs fail with errors like `Could not reserve enough space for 256000KB object heap`, apply the Java language patch script after starting your Judge0 containers.

PowerShell (Windows):
```powershell
.\scripts\patch-judge0-java-language.ps1
```

Bash (Linux/macOS):
```bash
bash ./scripts/patch-judge0-java-language.sh
```

Optional arguments:
- First arg/parameter: container name (default: `judge0-judge0-1`)
- Second arg/parameter: language id (default: `62`)
