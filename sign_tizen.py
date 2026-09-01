import os, sys, zipfile, hashlib, base64
from datetime import datetime, timedelta
from cryptography import x509
from cryptography.x509.oid import NameOID
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa, padding

def generate_tizen_cert():
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    subject = issuer = x509.Name([
        x509.NameAttribute(NameOID.COUNTRY_NAME, "ES"),
        x509.NameAttribute(NameOID.ORGANIZATION_NAME, "Tizen Developer"),
        x509.NameAttribute(NameOID.COMMON_NAME, "KovalskyTV Developer"),
    ])
    cert = x509.CertificateBuilder().subject_name(
        subject
    ).issuer_name(
        issuer
    ).public_key(
        key.public_key()
    ).serial_number(
        x509.random_serial_number()
    ).not_valid_before(
        datetime.utcnow() - timedelta(days=1)
    ).not_valid_after(
        datetime.utcnow() + timedelta(days=3650)
    ).sign(key, hashes.SHA256())
    
    return key, cert

def build_xmldsig(filename, file_hashes, cert, key):
    cert_b64 = base64.b64encode(cert.public_bytes(serialization.Encoding.DER)).decode('utf-8')
    
    ref_xml = ""
    for path, sha256_b64 in file_hashes.items():
        ref_xml += f"""    <Reference URI="{path}">
      <DigestMethod Algorithm="http://www.w3.org/2001/04/xmlenc#sha256"/>
      <DigestValue>{sha256_b64}</DigestValue>
    </Reference>\n"""
    
    signed_info_xml = f"""<SignedInfo xmlns="http://www.w3.org/2000/09/xmldsig#">
  <CanonicalizationMethod Algorithm="http://www.w3.org/TR/2001/REC-xml-c14n-20010315"/>
  <SignatureMethod Algorithm="http://www.w3.org/2001/04/xmldsig-more#rsa-sha256"/>
{ref_xml}</SignedInfo>"""

    # Sign SignedInfo
    signature_bytes = key.sign(
        signed_info_xml.encode('utf-8'),
        padding.PKCS1v15(),
        hashes.SHA256()
    )
    sig_b64 = base64.b64encode(signature_bytes).decode('utf-8')
    
    full_xml = f"""<?xml version="1.0" encoding="UTF-8"?>
<Signature xmlns="http://www.w3.org/2000/09/xmldsig#" Id="{filename[:-4]}">
{signed_info_xml}
  <SignatureValue>{sig_b64}</SignatureValue>
  <KeyInfo>
    <X509Data>
      <X509Certificate>{cert_b64}</X509Certificate>
    </X509Data>
  </KeyInfo>
</Signature>"""
    return full_xml

def sign_wgt(input_wgt, output_wgt):
    key, cert = generate_tizen_cert()
    
    temp_dir = "/tmp/tizen_sign_temp"
    if os.path.exists(temp_dir):
        import shutil
        shutil.rmtree(temp_dir)
    os.makedirs(temp_dir, exist_ok=True)
    
    with zipfile.ZipFile(input_wgt, 'r') as z:
        z.extractall(temp_dir)
        
    file_hashes = {}
    for root, dirs, files in os.walk(temp_dir):
        for f in files:
            if f in ['author-signature.xml', 'signature1.xml']:
                continue
            full_path = os.path.join(root, f)
            rel_path = os.path.relpath(full_path, temp_dir).replace('\\', '/')
            with open(full_path, 'rb') as fp:
                content = fp.read()
                h = hashlib.sha256(content).digest()
                file_hashes[rel_path] = base64.b64encode(h).decode('utf-8')
                
    author_xml = build_xmldsig("author-signature.xml", file_hashes, cert, key)
    with open(os.path.join(temp_dir, "author-signature.xml"), "w") as fp:
        fp.write(author_xml)
        
    # Recalculate including author-signature for signature1
    file_hashes_sig1 = dict(file_hashes)
    h_author = hashlib.sha256(author_xml.encode('utf-8')).digest()
    file_hashes_sig1["author-signature.xml"] = base64.b64encode(h_author).decode('utf-8')
    
    sig1_xml = build_xmldsig("signature1.xml", file_hashes_sig1, cert, key)
    with open(os.path.join(temp_dir, "signature1.xml"), "w") as fp:
        fp.write(sig1_xml)
        
    with zipfile.ZipFile(output_wgt, 'w', zipfile.ZIP_DEFLATED) as z:
        for root, dirs, files in os.walk(temp_dir):
            for f in files:
                full_path = os.path.join(root, f)
                rel_path = os.path.relpath(full_path, temp_dir)
                z.write(full_path, rel_path)
                
    print(f"✅ Signed WGT successfully created at: {output_wgt}")

if __name__ == '__main__':
    sign_wgt(
        "/home/amin/Escritorio/KovalskyTV_Flutter.wgt",
        "/home/amin/Escritorio/KovalskyTV_Flutter_Signed.wgt"
    )
