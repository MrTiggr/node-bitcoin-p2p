#include <cctype>
#include <cstdlib>
#include <cstring>
#include <stdio.h>

#include <v8.h>

#include <node.h>
#include <node_buffer.h>

#include <openssl/bn.h>
#include <openssl/buffer.h>
#include <openssl/ecdsa.h>
#include <openssl/evp.h>
#include <openssl/rand.h>
#include <openssl/sha.h>
#include <openssl/ripemd.h>


using namespace std;
using namespace v8;
using namespace node;



static Handle<Value> VException(const char *msg) {
    HandleScope scope;
    return ThrowException(Exception::Error(String::New(msg)));
}


static Handle<Value>
new_keypair (const Arguments& args)
{
  HandleScope scope;
  EC_KEY* pkey;
  
  // Generate
  pkey = EC_KEY_new_by_curve_name(NID_secp256k1);
  if (pkey == NULL) {
    return VException("Error from EC_KEY_new_by_curve_name");
  }
  if (!EC_KEY_generate_key(pkey)) {
    return VException("Error from EC_KEY_generate_key");
  }
  
  // Export private
  unsigned int priv_size = i2d_ECPrivateKey(pkey, NULL);
  if (!priv_size) {
    return VException("Error from i2d_ECPrivateKey(pkey, NULL)");
  }
  unsigned char *priv = (unsigned char *)malloc(priv_size);
  if (i2d_ECPrivateKey(pkey, &priv) != priv_size) {
   return VException("Error from i2d_ECPrivateKey(pkey, &priv)");
  }
  
  // Export public
  unsigned int pub_size = i2o_ECPublicKey(pkey, NULL);
  if (!pub_size) {
    return VException("Error from i2o_ECPublicKey(pkey, NULL)");
  }
  unsigned char *pub = (unsigned char *)malloc(pub_size);
  if (i2o_ECPublicKey(pkey, &pub) != pub_size) {
    return VException("Error from i2o_ECPublicKey(pkey, &pub)");
  }
  
  // Return [priv_buf, pub_buf]
  
  Local<Array> a = Array::New(2);
  
  Buffer *priv_buf = Buffer::New(priv_size);
  memcpy(Buffer::Data(priv_buf), priv, priv_size);
  a->Set(Integer::New(0), priv_buf->handle_);
  
  Buffer *pub_buf = Buffer::New(pub_size);
  memcpy(Buffer::Data(pub_buf), pub, pub_size);
  a->Set(Integer::New(1), pub_buf->handle_);
  
  EC_KEY_free(pkey);
  free(priv);
  free(pub);

  return scope.Close(a);
}

static Handle<Value>
verify_sig (const Arguments& args)
{
  HandleScope scope;
  EC_KEY* pkey;
  
  if (args.Length() != 3) {
    return VException("Three arguments expected: sig, pubkey, hash");
  }
  if (!Buffer::HasInstance(args[0])) {
    return VException("Argument 'sig' must be of type Buffer");
  }
  if (!Buffer::HasInstance(args[1])) {
    return VException("Argument 'pubkey' must be of type Buffer");
  }
  if (!Buffer::HasInstance(args[2])) {
    return VException("Argument 'hash' must be of type Buffer");
  }

  v8::Handle<v8::Object> sig_buf = args[0]->ToObject();
  v8::Handle<v8::Object> pub_buf = args[1]->ToObject();
  v8::Handle<v8::Object> hash_buf = args[2]->ToObject();

  const unsigned char *sig_data = (unsigned char *) Buffer::Data(sig_buf);
  const unsigned char *pub_data = (unsigned char *) Buffer::Data(pub_buf);
  const unsigned char *hash_data = (unsigned char *) Buffer::Data(hash_buf);

  unsigned int sig_len = Buffer::Length(sig_buf);
  unsigned int pub_len = Buffer::Length(pub_buf);
  unsigned int hash_len = Buffer::Length(hash_buf);

  if (hash_len != 32) {
    return VException("Argument 'hash' must be Buffer of length 32 bytes");
  }

  // Allocate pkey
  pkey = EC_KEY_new_by_curve_name(NID_secp256k1);
  if (pkey == NULL) {
    return VException("Error from EC_KEY_new_by_curve_name");
  }

  // Load public key
  if (!o2i_ECPublicKey(&pkey, &pub_data, pub_len)) {
    return VException("Error from o2i_ECPublicKey(&pkey, pub_data, pub_len)");
  }

  // Verify signature
  int result = ECDSA_verify(0, hash_data, hash_len, sig_data, sig_len, pkey);

  // Free key
  EC_KEY_free(pkey);

  if (result == -1) {
    return VException("Error during ECDSA_verify");
  } else if (result == 0) {
    // Signature invalid
    return scope.Close(v8::Boolean::New(false));
  } else if (result == 1) {
    // Signature valid
    return scope.Close(v8::Boolean::New(true));
  } else {
    return VException("ECDSA_verify gave undefined return value");
  }
}

static Handle<Value>
pubkey_to_address256 (const Arguments& args)
{
  HandleScope scope;
  
  if (args.Length() != 1) {
    return VException("One argument expected: pubkey Buffer");
  }
  if (!Buffer::HasInstance(args[0])) {
    return VException("One argument expected: pubkey Buffer");
  }
  v8::Handle<v8::Object> pub_buf = args[0]->ToObject();
  
  unsigned char *pub_data = (unsigned char *) Buffer::Data(pub_buf);
  
  // sha256(pubkey)
  unsigned char hash1[SHA256_DIGEST_LENGTH];
  SHA256_CTX c;
  SHA256_Init(&c);
  SHA256_Update(&c, pub_data, Buffer::Length(pub_buf));
  SHA256_Final(hash1, &c);
  
  // ripemd160(sha256(pubkey))
  unsigned char hash2[RIPEMD160_DIGEST_LENGTH];
  RIPEMD160_CTX c2;
  RIPEMD160_Init(&c2);
  RIPEMD160_Update(&c2, hash1, SHA256_DIGEST_LENGTH);
  RIPEMD160_Final(hash2, &c2);
  
  // x = '\x00' + ripemd160(sha256(pubkey))
  // LATER: make the version an optional argument
  unsigned char address256[1 + RIPEMD160_DIGEST_LENGTH + 4];
  address256[0] = 0;
  memcpy(address256 + 1, hash2, RIPEMD160_DIGEST_LENGTH);
  
  // sha256(x)
  unsigned char hash3[SHA256_DIGEST_LENGTH];
  SHA256_CTX c3;
  SHA256_Init(&c3);
  SHA256_Update(&c3, address256, 1 + RIPEMD160_DIGEST_LENGTH);
  SHA256_Final(hash3, &c3);
  
  // address256 = (x + sha256(x)[:4])
  memcpy(
    address256 + (1 + RIPEMD160_DIGEST_LENGTH),
    hash3,
    4);
  
  Buffer *address256_buf = Buffer::New(1 + RIPEMD160_DIGEST_LENGTH + 4);
  memcpy(Buffer::Data(address256_buf), address256, 1 + RIPEMD160_DIGEST_LENGTH + 4);
  return scope.Close(address256_buf->handle_);
}


static const char* BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";


static Handle<Value>
base58_encode (const Arguments& args)
{
  HandleScope scope;
  
  if (args.Length() != 1) {
    return VException("One argument expected: a Buffer");
  }
  if (!Buffer::HasInstance(args[0])) {
    return VException("One argument expected: a Buffer");
  }
  v8::Handle<v8::Object> buf = args[0]->ToObject();
  
  unsigned char *buf_data = (unsigned char *) Buffer::Data(buf);
  int buf_length = Buffer::Length(buf);
  
  BN_CTX *ctx = BN_CTX_new();
  
  BIGNUM *bn = BN_bin2bn(buf_data, buf_length, NULL);
  
  BIGNUM *bn58 = BN_new();
  BN_set_word(bn58, 58);
  
  BIGNUM *bn0 = BN_new();
  BN_set_word(bn0, 0);
  
  BIGNUM *dv = BN_new();
  BIGNUM *rem = BN_new();
  
  // TODO: compute safe length
  char *str = new char[100];
  unsigned int c;
  int i, j, j2;
  
  i = 0;
  while (BN_cmp(bn, bn0) > 0) {
    if (!BN_div(dv, rem, bn, bn58, ctx)) {
      return VException("BN_div failed");
    }
    if (bn != dv) {
      BN_free(bn);
      bn = dv;
    }
    c = BN_get_word(rem);
    str[i] = BASE58_ALPHABET[c];
    i++;
  }
  
  // Leading zeros
  for (j = 0; j < buf_length; j++) {
    if (buf_data[j] != 0) {
      break;
    }
    str[i] = BASE58_ALPHABET[0];
    i++;
  }
  
  // Terminator
  str[i] = 0;
  
  // Reverse string
  int numSwaps = (i / 2);
  char tmp;
  for (j = 0; j < numSwaps; j++) {
    j2 = i - 1 - j;
    tmp = str[j];
    str[j] = str[j2];
    str[j2] = tmp;
  }
  
  BN_free(bn);
  BN_free(bn58);
  BN_free(bn0);
  BN_free(rem);
  BN_CTX_free(ctx);
  
  Local<String> ret = String::New(str);
  delete [] str;
  return scope.Close(ret);
}


static Handle<Value>
base58_decode (const Arguments& args)
{
  HandleScope scope;
  
  if (args.Length() != 1) {
    return VException("One argument expected: a String");
  }
  if (!args[0]->IsString()) {
    return VException("One argument expected: a String");
  }
  
  BN_CTX *ctx = BN_CTX_new();
  
  BIGNUM *bn58 = BN_new();
  BN_set_word(bn58, 58);
  
  BIGNUM *bn = BN_new();
  BN_set_word(bn, 0);

  BIGNUM *bnChar = BN_new();

  String::Utf8Value str(args[0]->ToString());
  char *psz = *str;
  
  while (isspace(*psz))
    psz++;
  
  // Convert big endian string to bignum
  for (const char* p = psz; *p; p++) {
    const char* p1 = strchr(BASE58_ALPHABET, *p);
    if (p1 == NULL) {
      while (isspace(*p))
        p++;
      if (*p != '\0')
        return VException("Error");
      break;
    }
    BN_set_word(bnChar, p1 - BASE58_ALPHABET);
    if (!BN_mul(bn, bn, bn58, ctx))
      return VException("BN_mul failed");
    if (!BN_add(bn, bn, bnChar))
      return VException("BN_add failed");
  }

  // Get bignum as little endian data
  unsigned int tmpLen = BN_num_bytes(bn);
  unsigned char *tmp = (unsigned char *)malloc(tmpLen);
  BN_bn2bin(bn, tmp);

  // Trim off sign byte if present
  if (tmpLen >= 2 && tmp[tmpLen-1] == 0 && tmp[tmpLen-2] >= 0x80)
    tmpLen--;
  
  // Restore leading zeros
  int nLeadingZeros = 0;
  for (const char* p = psz; *p == BASE58_ALPHABET[0]; p++)
    nLeadingZeros++;

  // Allocate buffer and zero it
  Buffer *buf = Buffer::New(nLeadingZeros + tmpLen);
  char* data = Buffer::Data(buf);
  memset(data, 0, nLeadingZeros + tmpLen);
  memcpy(data+nLeadingZeros, tmp, tmpLen);

  BN_free(bn58);
  BN_free(bn);
  BN_free(bnChar);
  BN_CTX_free(ctx);
  free(tmp);

  return scope.Close(buf->handle_);
}


int static FormatHashBlocks(void* pbuffer, unsigned int len)
{
  unsigned char* pdata = (unsigned char*)pbuffer;
  unsigned int blocks = 1 + ((len + 8) / 64);
  unsigned char* pend = pdata + 64 * blocks;
  memset(pdata + len, 0, 64 * blocks - len);
  pdata[len] = 0x80;
  unsigned int bits = len * 8;
  pend[-1] = (bits >> 0) & 0xff;
  pend[-2] = (bits >> 8) & 0xff;
  pend[-3] = (bits >> 16) & 0xff;
  pend[-4] = (bits >> 24) & 0xff;
  return blocks;
}

static Handle<Value>
sha256_midstate (const Arguments& args)
{
  HandleScope scope;

  if (args.Length() != 1) {
    return VException("One argument expected: data Buffer");
  }
  if (!Buffer::HasInstance(args[0])) {
    return VException("One argument expected: data Buffer");
  }
  v8::Handle<v8::Object> blk_buf = args[0]->ToObject();

  // Reserve 64 extra bytes of memory for padding
  unsigned int blk_len = Buffer::Length(blk_buf);
  unsigned char *blk_data = (unsigned char *) malloc(blk_len + 64);

  // Get block header
  memcpy(blk_data, Buffer::Data(blk_buf), blk_len);

  // Add SHA256 padding
  FormatHashBlocks(blk_data, blk_len);

  // Execute first half of first hash on block data
  SHA256_CTX c;
  SHA256_Init(&c);
  SHA256_Transform(&c, blk_data);

  // Note that we don't run SHA256_Final and return the middle state instead

  Buffer *midstate_buf = Buffer::New(SHA256_DIGEST_LENGTH);
  memcpy(Buffer::Data(midstate_buf), &c.h, SHA256_DIGEST_LENGTH);

  free(blk_data);

  return scope.Close(midstate_buf->handle_);
}


extern "C" void
init (Handle<Object> target)
{
  HandleScope scope;
  target->Set(String::New("new_keypair"), FunctionTemplate::New(new_keypair)->GetFunction());
  target->Set(String::New("pubkey_to_address256"), FunctionTemplate::New(pubkey_to_address256)->GetFunction());
  target->Set(String::New("verify_sig"), FunctionTemplate::New(verify_sig)->GetFunction());
  target->Set(String::New("base58_encode"), FunctionTemplate::New(base58_encode)->GetFunction());
  target->Set(String::New("base58_decode"), FunctionTemplate::New(base58_decode)->GetFunction());
  target->Set(String::New("sha256_midstate"), FunctionTemplate::New(sha256_midstate)->GetFunction());
}
