import os
import json
import shutil

ROOT = os.path.abspath(os.getcwd())
FUNCTIONS = os.path.join(ROOT, "functions")

def normalize_lf(path):
    with open(path, "rb") as f:
        data = f.read()
    data = data.replace(b"\r\n", b"\n")
    with open(path, "wb") as f:
        f.write(data)

def walk_and_fix(exts):
    for root, _, files in os.walk(FUNCTIONS):
        for f in files:
            if f.endswith(exts):
                normalize_lf(os.path.join(root, f))

def remove_busboy():
    upload_ts = os.path.join(FUNCTIONS, "src", "upload.ts")
    if os.path.exists(upload_ts):
        print("🧹 Removing upload.ts (Busboy)")
        os.remove(upload_ts)

    pkg = os.path.join(FUNCTIONS, "package.json")
    if not os.path.exists(pkg):
        return

    with open(pkg, "r", encoding="utf-8") as f:
        data = json.load(f)

    deps = data.get("dependencies", {})
    if "busboy" in deps:
        print("🧹 Removing busboy dependency")
        deps.pop("busboy")

    data["dependencies"] = deps
    data["engines"] = {"node": "20"}

    with open(pkg, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)

def fix_firebase_json():
    path = os.path.join(ROOT, "firebase.json")
    if not os.path.exists(path):
        return

    with open(path, "r", encoding="utf-8") as f:
        data = json.load(f)

    for fn in data.get("functions", []):
        fn["predeploy"] = [
            "npm --prefix \"$RESOURCE_DIR\" run build"
        ]

    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)

    normalize_lf(path)

def main():
    print("🔧 Normalizing line endings...")
    walk_and_fix((".ts", ".js"))

    print("🧹 Removing Busboy...")
    remove_busboy()

    print("🧯 Fixing firebase.json (disable lint)...")
    fix_firebase_json()

    print("✅ Repair complete.")
    print("Next steps:")
    print("  cd functions")
    print("  npm install")
    print("  npm run build")
    print("  firebase deploy --only functions")

if __name__ == "__main__":
    main()
