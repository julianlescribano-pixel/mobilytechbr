import argparse
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DATA_FILE = ROOT / "data" / "products.json"
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


def find_jobs(products):
    jobs = []
    changed = False

    for index, product in enumerate(products):
        image_path = get_image_path(product)
        if not image_path or not image_path.exists():
            print(f"Skipping {product.get('title', index + 1)}: image file not found.", file=sys.stderr)
            continue

        cutout_path = get_cutout_path(product)
        if cutout_path and cutout_path.exists():
            continue

        product_id = slugify(product.get("id") or product.get("title") or f"produto-{index + 1}")
        output_path = OUTPUT_DIR / f"{product_id}-cutout.png"

        if output_path.exists() and not cutout_path:
            product["cutout"] = public_path(output_path)
            changed = True
            continue

        jobs.append((index, image_path, output_path))

    return jobs, changed


def save_products(products):
    DATA_FILE.write_text(json.dumps(products, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def load_products():
    with DATA_FILE.open("r", encoding="utf-8") as handle:
        products = json.load(handle)
    if not isinstance(products, list):
        raise ValueError("data/products.json must contain a JSON list.")
    return products


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


def generate_cutouts(products, jobs):
    from PIL import Image
    from rembg import new_session, remove

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    session = new_session()

    for index, image_path, output_path in jobs:
        print(f"Generating cutout: {image_path} -> {output_path}")
        with Image.open(image_path) as image:
            if image.mode not in ("RGB", "RGBA"):
                image = image.convert("RGBA")
            image = resize_for_processing(image)
            output = trim_transparent_padding(remove(image, session=session))
            output.save(output_path)
        products[index]["cutout"] = public_path(output_path)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true", help="Only report whether there are missing cutouts.")
    args = parser.parse_args()

    products = load_products()
    jobs, changed = find_jobs(products)

    if args.check:
        if changed:
            save_products(products)
        print(f"needed={'true' if jobs else 'false'}")
        print(f"count={len(jobs)}")
        return

    if not jobs:
        if changed:
            save_products(products)
            print("Updated products with existing generated cutouts.")
        else:
            print("No missing cutouts.")
        return

    generate_cutouts(products, jobs)
    save_products(products)
    print(f"Generated {len(jobs)} cutout(s).")


if __name__ == "__main__":
    main()
