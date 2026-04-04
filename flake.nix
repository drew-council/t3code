{
  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";

    bun2nix.url = "github:nix-community/bun2nix?tag=2.0.8";
    bun2nix.inputs.nixpkgs.follows = "nixpkgs";
    bun2nix.inputs.systems.follows = "flake-utils/systems";
  };

  nixConfig = {
    extra-substituters = [
      "https://cache.nixos.org"
      "https://nix-community.cachix.org"
    ];
    extra-trusted-public-keys = [
      "cache.nixos.org-1:6NCHdD59X431o0gWypbMrAURkbJ16ZPMQFGspcDShjY="
      "nix-community.cachix.org-1:mB9FSh9qf2dCimDSUo8Zy7bkq5CX+/rkCWyvRCYg3Fs="
    ];
  };

  outputs =
    {
      self,
      nixpkgs,
      flake-utils,
      bun2nix,
    }:
    flake-utils.lib.eachDefaultSystem (
      system:
      let
        pkgs = import nixpkgs {
          inherit system;
          overlays = [ bun2nix.overlays.default ];
        };

        revision =
          if self ? rev then self.rev else if self ? dirtyRev then self.dirtyRev else "unknown";

        t3code = pkgs.callPackage ./default.nix {
          src = self;
          inherit revision;
        };
        bun2nixCli = bun2nix.packages.${system}.default;

        t3codeApp = flake-utils.lib.mkApp {
          drv = t3code;
          name = "t3code";
        };
      in
      {
        devShells.default = pkgs.mkShell {
          packages = with pkgs; [
            (aspellWithDicts (ps: with ps; [ en ]))
            # keep-sorted start
            bun
            nixfmt
            nodejs_24
            nushell
            python3
            # keep-sorted end
            bun2nixCli
          ];
        };
      }
      // pkgs.lib.optionalAttrs pkgs.stdenv.hostPlatform.isLinux {
        packages = {
          inherit t3code;
          default = t3code;
        };

        apps = {
          t3code = t3codeApp;
          default = t3codeApp;
        };
      }
    );
}
