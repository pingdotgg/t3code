// Pin both the interpreter and Piper wheel; the host needs no Python or Piper installation.
export const PIPER_VERSION = "1.8.0-python-3.12.16-20261110";

const artifacts = {
  "linux-x64": {
    filename: "cpython-3.12.16+20261110-x86_64-unknown-linux-gnu-install_only.tar.gz",
    url: "https://github.com/astral-sh/python-build-standalone/releases/download/20261110/cpython-3.12.16%2B20261110-x86_64-unknown-linux-gnu-install_only.tar.gz",
    size: 68163679,
    sha256: "c2f87d4b4e8db3abddb0f116c6ccfc503d0cbdbb9ee8faacddad1b679ec12e99",
    wheelUrl:
      "https://files.pythonhosted.org/packages/84/81/0112a7d510911f33018dc24023d1655bb772f84a4e95fe7f0180f66bbd17/piper_tts-1.8.0-cp39-abi3-manylinux_2_17_x86_64.manylinux2014_x86_64.manylinux_2_28_x86_64.whl",
    wheelSha256: "25b4d3f31ff70c8fa7151908e00aaa5650cbdf16bca8fcf21299f3941b89a7d3",
  },
  "linux-arm64": {
    filename: "cpython-3.12.16+20261110-aarch64-unknown-linux-gnu-install_only.tar.gz",
    url: "https://github.com/astral-sh/python-build-standalone/releases/download/20261110/cpython-3.12.16%2B20261110-aarch64-unknown-linux-gnu-install_only.tar.gz",
    size: 53264815,
    sha256: "4792f81750282597fb2a3389fe18b945ed2ba6aad5e45ad406d122c58cb33081",
    wheelUrl:
      "https://files.pythonhosted.org/packages/5e/90/de832b09736db8c26c9b5dd25cb408ed065b1d9535e05c78947aec056e36/piper_tts-1.8.0-cp39-abi3-manylinux_2_17_aarch64.manylinux2014_aarch64.manylinux_2_28_aarch64.whl",
    wheelSha256: "3f60c1917de6d8e8033f395878ad3f88f6dfee88a8b05f98971a275f76a38484",
  },
  "darwin-x64": {
    filename: "cpython-3.12.16+20261110-x86_64-apple-darwin-install_only.tar.gz",
    url: "https://github.com/astral-sh/python-build-standalone/releases/download/20261110/cpython-3.12.16%2B20261110-x86_64-apple-darwin-install_only.tar.gz",
    size: 25078514,
    sha256: "83f2922437e6d546d0fcdb8c11f150a8e52787e8d9ea8651b1974e20908eb1bc",
    wheelUrl:
      "https://files.pythonhosted.org/packages/a7/2f/ad6db2adc635f85e9d2abd8e59bed3f04062c7b33817d519347fd79ad19f/piper_tts-1.8.0-cp39-abi3-macosx_10_9_x86_64.whl",
    wheelSha256: "98c7dd791b2be0f8732e5c9cefd86c54200ac0360e43c643c937bf18ac0e941a",
  },
  "darwin-arm64": {
    filename: "cpython-3.12.16+20261110-aarch64-apple-darwin-install_only.tar.gz",
    url: "https://github.com/astral-sh/python-build-standalone/releases/download/20261110/cpython-3.12.16%2B20261110-aarch64-apple-darwin-install_only.tar.gz",
    size: 25371130,
    sha256: "e956e60bc9465d577ef8062059aa05cd3a2665b4b8678a2ed24e432368330b8f",
    wheelUrl:
      "https://files.pythonhosted.org/packages/0a/f9/90e75adb55b3470a73030598c36f9969fe568e8458c066fa9b4fbc78a4c1/piper_tts-1.8.0-cp39-abi3-macosx_11_0_arm64.whl",
    wheelSha256: "33e7425933e9290fe651ae127916ed1ca6104cfa3d94e9049295dd3a5c449382",
  },
  "win32-x64": {
    filename: "cpython-3.12.16+20261110-x86_64-pc-windows-msvc-install_only.tar.gz",
    url: "https://github.com/astral-sh/python-build-standalone/releases/download/20261110/cpython-3.12.16%2B20261110-x86_64-pc-windows-msvc-install_only.tar.gz",
    size: 47438699,
    sha256: "e23fe5b16926de1d81661b1a97352e89fb167549c55a6825796ccd0f32ec7f1b",
    wheelUrl:
      "https://files.pythonhosted.org/packages/12/9c/c736d1961cf9ce0655278731b9430df41892ca2ded7b09dabcb340612158/piper_tts-1.8.0-cp39-abi3-win_amd64.whl",
    wheelSha256: "5da9bfdb05dfe15da3536859d422e605483ffa6d2b3ec2c5b9593bae6b5aa6a4",
  },
};

export function piperArtifact(platform: string, architecture: string, libc?: string) {
  if (platform === "linux" && libc !== "gnu") return null;
  const key = `${platform}-${architecture}`;
  return Object.hasOwn(artifacts, key) ? artifacts[key as keyof typeof artifacts] : null;
}
