{
  bun,
  lib,
  stdenv,
  bun2nix,
  copyDesktopItems,
  electron_40,
  makeDesktopItem,
  makeWrapper,
  nodejs_24,
  python3,
  ripgrep,
  writableTmpDirAsHomeHook,
  src,
  revision ? "unknown",
}:
let
  desktopPackage = builtins.fromJSON (builtins.readFile ./apps/desktop/package.json);
  serverPackage = builtins.fromJSON (builtins.readFile ./apps/server/package.json);

  version = desktopPackage.version;

  bunDeps = bun2nix.fetchBunDeps {
    bunNix = ./bun.nix;
  };

  bunInstallFlags =
    if stdenv.hostPlatform.isDarwin then
      [
        "--frozen-lockfile"
        "--linker=hoisted"
        "--backend=copyfile"
      ]
    else
      [
        "--frozen-lockfile"
        "--linker=hoisted"
      ];

  revisionMatch = builtins.match "([0-9A-Fa-f]{7,40}).*" revision;
  normalizedRevision =
    if revisionMatch == null then "unknown" else lib.toLower (builtins.head revisionMatch);

  nodeModules = stdenv.mkDerivation {
    pname = "t3code-node-modules";
    inherit
      version
      src
      bunDeps
      bunInstallFlags
      ;

    strictDeps = true;
    dontRunLifecycleScripts = true;
    dontUseBunPatch = true;
    dontFixup = true;

    outputHashMode = "recursive";
    outputHashAlgo = "sha256";
    outputHash = "sha256-D/l9v4onFbfzlbujMINxSsojMJAlt/4pfy9onQB6two=";

    nativeBuildInputs = [
      bun2nix.hook
      ripgrep
      writableTmpDirAsHomeHook
    ];

    buildPhase = ''
      runHook preBuild

      chmod -R u+w node_modules

      rg -l '^#!/nix/store/' node_modules | while IFS= read -r path; do
        sed -i \
          -e '1 s|^#!/nix/store/.*/bin/node$|#!/usr/bin/env node|' \
          -e '1 s|^#!/nix/store/.*/bin/bun$|#!/usr/bin/env bun|' \
          -e '1 s|^#!/nix/store/.*/bin/sh$|#!/usr/bin/env sh|' \
          -e '1 s|^#!/nix/store/.*/bin/bash$|#!/usr/bin/env bash|' \
          -e '1 s|^#!/nix/store/.*/bin/python3\(\.[0-9][0-9.]*\)\?$|#!/usr/bin/env python3|' \
          "$path"
      done

      runHook postBuild
    '';

    installPhase = ''
      runHook preInstall

      mkdir -p "$out"
      cp -R node_modules "$out/"

      runHook postInstall
    '';
  };
in
assert lib.assertMsg (desktopPackage.version == serverPackage.version) ''
  apps/desktop/package.json and apps/server/package.json must have matching versions
'';
stdenv.mkDerivation {
  pname = "t3code";
  inherit
    version
    src
    bunDeps
    bunInstallFlags
    ;

  strictDeps = true;
  dontRunLifecycleScripts = true;

  postPatch = ''
    chmod -R u+w .
    cp -R ${nodeModules}/node_modules ./node_modules
    chmod -R u+w node_modules
  '';

  nativeBuildInputs = [
    bun
    copyDesktopItems
    makeWrapper
    nodejs_24
    python3
    writableTmpDirAsHomeHook
  ];

  buildPhase = ''
    runHook preBuild

    patchShebangs node_modules

    export npm_config_nodedir=${nodejs_24}
    npm rebuild node-pty --foreground-scripts

    bun run build:desktop

    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall

    local app_root="$out/lib/t3code"

    mkdir -p \
      "$app_root/apps/desktop" \
      "$app_root/apps/marketing" \
      "$app_root/apps/server" \
      "$app_root/apps/web" \
      "$app_root/packages" \
      "$out/bin"

    cp -R apps/desktop/dist-electron "$app_root/apps/desktop/"
    cp -R apps/desktop/resources "$app_root/apps/desktop/"
    cp -R apps/marketing "$app_root/apps/"
    cp -R apps/server/dist "$app_root/apps/server/"
    cp -R apps/web "$app_root/apps/"
    cp -R packages/client-runtime "$app_root/packages/"
    cp -R packages/contracts "$app_root/packages/"
    cp -R packages/shared "$app_root/packages/"
    cp -R scripts "$app_root/"
    cp -R node_modules "$app_root/"

    cat > "$app_root/package.json" <<EOF
    {
      "name": "t3code",
      "version": "${version}",
      "main": "apps/desktop/dist-electron/main.js",
      "t3codeCommitHash": "${normalizedRevision}"
    }
    EOF

    install -Dm644 apps/desktop/resources/icon.png \
      "$out/share/icons/hicolor/512x512/apps/t3code.png"

    makeWrapper ${lib.getExe electron_40} "$out/bin/t3code" \
      --add-flags "$app_root"

    runHook postInstall
  '';

  desktopItems = [
    (makeDesktopItem {
      name = "t3code";
      desktopName = desktopPackage.productName or "T3 Code";
      exec = "t3code %U";
      icon = "t3code";
      startupWMClass = "t3code";
      categories = [ "Development" ];
      keywords = [
        "AI"
        "Code"
        "Electron"
      ];
    })
  ];

  meta = {
    description = "Desktop app for T3 Code";
    homepage = "https://github.com/pingdotgg/t3code";
    license = lib.licenses.asl20;
    mainProgram = "t3code";
    platforms = lib.platforms.linux;
  };

  passthru = {
    inherit nodeModules;
  };
}
