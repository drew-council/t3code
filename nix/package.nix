# Adapted from nixpkgs pkgs/by-name/t3/t3code. The build follows this checkout,
# so only the pnpm dependency hash is pinned, in ./pnpm-deps.hash.
{
  lib,
  stdenv,
  src,
  version,
  pnpmDepsHash ? lib.fileContents ./pnpm-deps.hash,
  extraRuntimePackages ? [ ],
  cctools,
  copyDesktopItems,
  electron_44,
  fetchPnpmDeps,
  gh,
  git,
  installShellFiles,
  libicns,
  libsecret,
  makeBinaryWrapper,
  makeDesktopItem,
  node-gyp,
  nodejs_26,
  pkg-config,
  pnpmBuildHook,
  pnpmConfigHook,
  pnpm_12,
  python3,
  rustPlatform,
  symlinkJoin,
  writeDarwinBundle,
  xcbuild,
  cacert,
}:

let
  appName = "T3 Code (Alpha)";
  electron = electron_44;
  nodejs = nodejs_26;
  pnpm = pnpm_12;
  desktopIcon =
    if stdenv.hostPlatform.isDarwin then
      "assets/prod/black-macos-1024.png"
    else
      "assets/prod/black-universal-1024.png";

  meta = {
    description = "Minimal web GUI for coding agents";
    homepage = "https://github.com/drew-council/t3code";
    license = lib.licenses.mit;
    mainProgram = "t3code-desktop";
    inherit (nodejs.meta) platforms;
  };

  unwrapped = stdenv.mkDerivation (finalAttrs: {
    pname = "t3code-unwrapped";
    inherit version src;
    strictDeps = true;
    __structuredAttrs = true;

    postPatch = ''
      substituteInPlace apps/web/vite.config.ts \
        --replace-fail 'const host = explicitHost || "localhost";' \
                       'const host = explicitHost || "127.0.0.1";'
    '';

    nativeBuildInputs = [
      installShellFiles
      makeBinaryWrapper
      node-gyp
      nodejs
      python3
      pnpmConfigHook
      pnpmBuildHook
      pnpm
      cacert
    ]
    ++ lib.optionals stdenv.hostPlatform.isLinux [
      copyDesktopItems
      pkg-config
    ]
    ++ lib.optionals stdenv.hostPlatform.isDarwin [
      cctools.libtool
      libicns
      writeDarwinBundle
      xcbuild
    ];

    buildInputs = lib.optionals stdenv.hostPlatform.isLinux [ libsecret ];

    pnpmWorkspaces = [
      # `...` also includes workspace packages the listed ones depend on.
      "@t3tools/monorepo"
      "t3..."
      "@t3tools/desktop..."
      "@t3tools/scripts..."
    ];

    pnpmDeps = fetchPnpmDeps {
      inherit pnpm;
      inherit (finalAttrs)
        pname
        version
        src
        pnpmWorkspaces
        ;
      fetcherVersion = 5;
      hash = pnpmDepsHash;
    };

    preBuild = ''
      # pnpm otherwise detects the package version updates below as
      # dependency drift and runs another install, including lifecycle scripts.
      export pnpm_config_verify_deps_before_run=false

      node scripts/update-release-package-versions.ts ${finalAttrs.version}

      export npm_config_nodedir=${nodejs}
      export ELECTRON_SKIP_BINARY_DOWNLOAD=1
      # `vp config` in the monorepo workspace needs git.
      pnpm rebuild --pending "''${pnpmInstallFlags[@]}" --filter '!@t3tools/monorepo'
    '';

    pnpmBuildScript = "build:desktop";

    postBuild = ''
      pnpm vp cache clean
    '';

    # Dependencies vendor prebuilt, sometimes static, binaries for other
    # platforms. Leave them to fixup without patchelf or the tmpdir audit.
    dontPatchELF = true;
    noAuditTmpdir = true;

    installPhase = ''
      runHook preInstall

      mkdir --parents "$out"/libexec/t3code/apps/desktop "$out"/libexec/t3code/apps/server
      cp --recursive --no-preserve=mode node_modules "$out"/libexec/t3code
      cp --recursive --no-preserve=mode apps/server/{node_modules,dist} "$out"/libexec/t3code/apps/server
      cp --recursive --no-preserve=mode \
        apps/desktop/{package.json,node_modules,dist-electron} \
        "$out"/libexec/t3code/apps/desktop

      mkdir --parents "$out"/libexec/t3code/apps/desktop/prod-resources
      install --mode=444 ${desktopIcon} \
        "$out"/libexec/t3code/apps/desktop/prod-resources/icon.png
    ''
    + lib.optionalString stdenv.hostPlatform.isLinux ''
      install -Dm755 \
        native/browser-secret/build/${stdenv.hostPlatform.node.arch}/t3-browser-secret \
        "$out"/libexec/t3code/apps/desktop/prod-resources/browser-secret/t3-browser-secret
    ''
    + ''

      find "$out"/libexec/t3code -xtype l -delete

      makeWrapper ${lib.getExe nodejs} "$out"/bin/t3 \
        --add-flags "$out"/libexec/t3code/apps/server/dist/bin.mjs

      makeWrapper ${lib.getExe electron} "$out"/bin/t3code-desktop \
        --add-flags "$out"/libexec/t3code/apps/desktop \
        --inherit-argv0
    ''
    + lib.optionalString stdenv.hostPlatform.isDarwin ''
      # node-pty chmods this helper at runtime, after the store is immutable.
      find "$out"/libexec/t3code \
        -path '*/node-pty/prebuilds/darwin-*/spawn-helper' \
        -exec chmod 755 {} +

      mkdir --parents "$out/Applications/${appName}.app/Contents/"{MacOS,Resources}
      png2icns \
        "$out/Applications/${appName}.app/Contents/Resources/t3code.icns" \
        ${desktopIcon}

      ${stdenv.shell} ${lib.getExe writeDarwinBundle} \
        "$out" "${appName}" t3code-desktop t3code
    ''
    + ''
      mkdir --parents \
        "$out"/share/icons/hicolor/{1024x1024,scalable}/apps
      install --mode=444 ${desktopIcon} \
        "$out"/share/icons/hicolor/1024x1024/apps/t3code.png
      install --mode=444 assets/prod/logo.svg \
        "$out"/share/icons/hicolor/scalable/apps/t3code.svg

      runHook postInstall
    '';

    postInstall = lib.optionalString (stdenv.buildPlatform.canExecute stdenv.hostPlatform) ''
      for shell in bash fish zsh; do
        installShellCompletion --cmd t3 --"$shell" <("$out/bin/t3" --completions "$shell")
      done
    '';

    postFixup = lib.optionalString stdenv.hostPlatform.isLinux ''
      # Electron's Node runtime does not provide libstdc++ for the node-pty prebuild.
      for module in "$out"/libexec/t3code/node_modules/.pnpm/node-pty@*/node_modules/node-pty/prebuilds/linux-${stdenv.hostPlatform.node.arch}/pty.node; do
        patchelf --add-rpath ${lib.makeLibraryPath [ stdenv.cc.cc.lib ]} "$module"
      done
    '';

    desktopItems = [
      (makeDesktopItem {
        name = "t3code";
        desktopName = appName;
        comment = "Minimal web GUI for coding agents";
        exec = "t3code-desktop %U";
        terminal = false;
        icon = "t3code";
        startupWMClass = "t3code";
        categories = [ "Development" ];
      })
    ];

    inherit meta;
  });

  resourceMonitor = rustPlatform.buildRustPackage {
    pname = "t3code-resource-monitor";
    inherit version;
    src = "${src}/native/resource-monitor";
    cargoLock.lockFile = "${src}/native/resource-monitor/Cargo.lock";
    meta = meta // {
      description = "Native resource diagnostics sidecar for T3 Code";
      mainProgram = "t3-resource-monitor";
    };
  };

  runtimePackages = [
    gh
    git
  ]
  ++ extraRuntimePackages;
in
symlinkJoin {
  pname = "t3code";
  inherit version;
  __structuredAttrs = true;
  strictDeps = true;

  paths = [ unwrapped ];

  nativeBuildInputs = [ makeBinaryWrapper ];

  # The server checks T3CODE_RESOURCE_MONITOR_PATH before bundled locations,
  # and the desktop app's server child inherits it.
  postBuild = ''
    for program in "$out/bin"/*; do
      wrapProgram "$program" \
        --prefix PATH : ${lib.makeBinPath runtimePackages} \
        --set-default T3CODE_RESOURCE_MONITOR_PATH ${lib.getExe resourceMonitor}
    done
  '';

  passthru = {
    inherit unwrapped resourceMonitor;
  };

  inherit meta;
}
