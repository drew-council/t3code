# NixOS Installation

If you use a flake-based NixOS config, you can install T3 Code by:

1. Adding this repo to your flake inputs.
2. Importing its NixOS module.

## 1. Add T3 Code to `inputs`

In your system `flake.nix`, add a `t3code` input:

```nix
{
  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    t3code.url = "github:bizmythy/t3code";
  };
}
```

## 2. Include the NixOS module

Then add the module to your `nixosConfigurations.<hostname>.modules` list:

```nix
{
  outputs = { nixpkgs, t3code, ... }: {
    nixosConfigurations.my-host = nixpkgs.lib.nixosSystem {
      system = "x86_64-linux";
      modules = [
        ./configuration.nix
        t3code.nixosModules.t3code
      ];
    };
  };
}
```

This module adds the `t3code` package to `environment.systemPackages`.

## 3. Rebuild

Apply the change with `nh` if you use it:

```bash
nh os switch
```

Otherwise, use `nixos-rebuild`:

```bash
sudo nixos-rebuild switch --flake .#my-host
```

After the rebuild finishes, `t3code` should be available in your shell.
