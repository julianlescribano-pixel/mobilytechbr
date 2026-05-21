import argparse
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PRODUCTS_FILE = ROOT / "data" / "products.json"
ADDONS_FILE = ROOT / "data" / "addons.json"
OUTPUT_DIR = ROOT / "assets" / "generated"
MAX_EDGE = 2200
TRIM_PADDING_RATIO = 0.045
TRIM_MIN_PADDING = 16


def slugify(value):
    slug = re.sub(r"[^a-z0-9]+", "-", str(value).lower()).strip("-")
    return slug or "produto"


def local_path(value):
    if not value:
        return None
    raw = str(value).strip()
    if re.match(r"^(https?:|data:|mailto:|tel:|#)", raw):
        return None
    normalized = raw.replace("\\", "/")
    normalized = re.sub(r"^\./", "", normalized).lstrip("/")
    return ROOT / normalized


def public_path(path):
    return "./" + path.relative_to(ROOT).as_posix()


def get_image_path(product):
    return local_path(product.get("image") or product.get("img"))


def get_cutout_path(product):
    return local_path(product.get("cutout") or product.get("imageCutout") or product.get("cutoutImage"))


def append_cutout_job(jobs, item, output_slug, label):
    if not isinstance(item, dict):
        return False

    image_path = get_image_path(item)
    if not image_path or not image_path.exists():
        if item.get("image") or item.get("img"):
            print(f"Skipping {label}: image file not found.", file=sys.stderr)
        return False

    cutout_path = get_cutout_path(item)
    if cutout_path and cutout_path.exists():
        return False

    output_path = OUTPUT_DIR / f"{slugify(output_slug)}-cutout.png"
    if output_path.exists() and not cutout_path:
        item["cutout"] = public_path(output_path)
        return True

    jobs.append((item, image_path, output_path, label))
    return False


def normalize_gallery(product):
    gallery = product.get("gallery")
    if not isinstance(gallery, list):
        return [], False

    normalized = []
    changed = False
    for item in gallery:
        if isinstance(item, str):
            normalized.append({"image": item})
            changed = True
        elif isinstance(item, dict):
            normalized.append(item)
        else:
            changed = True

    if changed:
        product["gallery"] = normalized
    return normalized, changed


def find_jobs(products, addons):
    jobs = []
    changed = False

    for index, product in enumerate(products):
        product_id = slugify(product.get("id") or product.get("title") or f"produto-{index + 1}")
        label = product.get("title") or f"produto-{index + 1}"
        changed = append_cutout_job(jobs, product, product_id, label) or changed

        gallery, gallery_changed = normalize_gallery(product)
        changed = gallery_changed or changed
        for gallery_index, photo in enumerate(gallery, start=1):
            changed = append_cutout_job(
                jobs,
                photo,
                f"{product_id}-gallery-{gallery_index}",
                f"{label} gallery {gallery_index}",
            ) or changed

        source = product.get("addons") or product.get("options") or {}
        if isinstance(source, dict):
            for category, options in source.items():
                if not isinstance(options, list):
                    continue
                for addon_index, option in enumerate(options, start=1):
                    addon_slug = option.get("id") or option.get("label") or option.get("name") or f"addon-{addon_index}"
                    changed = append_cutout_job(
                        jobs,
                        option,
                        f"{product_id}-{category}-{addon_slug}",
                        f"{label} addon {addon_slug}",
                    ) or changed

    for addon_index, addon in enumerate(addons, start=1):
        addon_slug = addon.get("id") or addon.get("label") or addon.get("name") or f"addon-{addon_index}"
        changed = append_cutout_job(
            jobs,
            addon,
            f"global-{addon_slug}",
            f"global addon {addon_slug}",
        ) or changed

    return jobs, changed


def save_products(products):
    PRODUCTS_FILE.write_text(json.dumps(products, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def save_addons(addons):
    ADDONS_FILE.write_text(json.dumps(addons, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def load_products():
    with PRODUCTS_FILE.open("r", encoding="utf-8") as handle:
        products = json.load(handle)
    if not isinstance(products, list):
        raise ValueError("data/products.json must contain a JSON list.")
    return products


def load_addons():
    if not ADDONS_FILE.exists():
        return []
    with ADDONS_FILE.open("r", encoding="utf-8") as handle:
        addons = json.load(handle)
    if not isinstance(addons, list):
        raise ValueError("data/addons.json must contain a JSON list.")
    return addons


def resize_for_processing(image):
    width, height = image.size
    largest = max(width, height)
    if largest <= MAX_EDGE:
        return image
    scale = MAX_EDGE / largest
    return image.resize((round(width * scale), round(height * scale)))


def trim_transparent_padding(image):
    from PIL import Image

    if image.mode != "RGBA":
        image = image.convert("RGBA")

    bbox = image.getchannel("A").getbbox()
    if not bbox:
        return image

    cropped = image.crop(bbox)
    padding = max(TRIM_MIN_PADDING, round(max(cropped.size) * TRIM_PADDING_RATIO))
    framed = Image.new(
        "RGBA",
        (cropped.width + padding * 2, cropped.height + padding * 2),
        (0, 0, 0, 0),
    )
    framed.paste(cropped, (padding, padding), cropped)
    return framed


def generate_cutouts(jobs):
    from PIL import Image
    from rembg import new_session, remove

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    session = new_session()

    for item, image_path, output_path, _label in jobs:
        print(f"Generating cutout: {image_path} -> {output_path}")
        with Image.open(image_path) as image:
            if image.mode not in ("RGB", "RGBA"):
                image = image.convert("RGBA")
            image = resize_for_processing(image)
            output = trim_transparent_padding(remove(image, session=session))
            output.save(output_path)
        item["cutout"] = public_path(output_path)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true", help="Only report whether there are missing cutouts.")
    args = parser.parse_args()

    products = load_products()
    addons = load_addons()
    jobs, changed = find_jobs(products, addons)

    if args.check:
        if changed:
            save_products(products)
            save_addons(addons)
        print(f"needed={'true' if jobs else 'false'}")
        print(f"count={len(jobs)}")
        return

    if not jobs:
        if changed:
            save_products(products)
            save_addons(addons)
            print("Updated data files with existing generated cutouts.")
        else:
            print("No missing cutouts.")
        return

    generate_cutouts(jobs)
    save_products(products)
    save_addons(addons)
    print(f"Generated {len(jobs)} cutout(s).")


if __name__ == "__main__":
    main()
