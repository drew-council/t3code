{
  description = "T3 Code";

  inputs.nixpkgs.url = "github:nixos/nixpkgs/nixos-unstable";

  outputs =
    { self, nixpkgs }:
    let
      inherit (nixpkgs) lib;

      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "aarch64-darwin"
      ];
      forAllSystems = f: lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});

      baseVersion = (lib.importJSON ./apps/server/package.json).version;
      version = "${baseVersion}-drew.${builtins.substring 0 8 (self.lastModifiedDate or "19700101")}";

      t3code =
        pkgs:
        pkgs.callPackage ./nix/package.nix {
          inherit version;
          src = self;
        };
    in
    {
      overlays.default = final: _prev: { t3code = t3code final; };

      packages = forAllSystems (pkgs: {
        default = t3code pkgs;
        t3code = t3code pkgs;
        # Fails with the current pnpm dependency hash; see nix/update-pnpm-deps-hash.sh.
        pnpmDepsFakeHash = ((t3code pkgs).override { pnpmDepsHash = lib.fakeHash; }).unwrapped.pnpmDeps;
      });

      devShells = forAllSystems (pkgs: {
        default = pkgs.mkShell {
          packages = with pkgs; [
            (aspellWithDicts (ps: with ps; [ en ]))
            nushell
            nodejs_26
            pnpm_12
            python3
            cargo
            rustc
            gh
          ];
        };
      });
    };
}
