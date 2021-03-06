var Opcode = require('./opcode').Opcode;
var bigint = require('bigint');
var logger = require('./logger');

var Util = require('./util');
var Script = require('./script').Script;

// Make opcodes available as pseudo-constants
for (var i in Opcode.map) {
  eval(i + " = " + Opcode.map[i] + ";");
}

var ScriptInterpreter = exports.ScriptInterpreter =
function ScriptInterpreter() {
  this.stack = [];
  this.disableUnsafeOpcodes = true;
};

ScriptInterpreter.prototype.eval = function eval(script, tx, n, hashType) {
  var pc = 0;

  var execStack = [];
  var altStack = [];
  var hashStart = 0;

  try {
    while (pc < script.chunks.length) {

      // The execution bit is true if there are no "false" values in the
      // execution stack. (A "false" value indicates that we're in the
      // inactive branch of an if statement.)
      var exec = !~execStack.indexOf(false);

      var opcode = script.chunks[pc++];
      if (this.disableUnsafeOpcodes &&
          (opcode == OP_CAT ||
           opcode == OP_SUBSTR ||
           opcode == OP_LEFT ||
           opcode == OP_RIGHT ||
           opcode == OP_INVERT ||
           opcode == OP_AND ||
           opcode == OP_OR ||
           opcode == OP_XOR ||
           opcode == OP_2MUL ||
           opcode == OP_2DIV ||
           opcode == OP_MUL ||
           opcode == OP_DIV ||
           opcode == OP_MOD ||
           opcode == OP_LSHIFT ||
           opcode == OP_RSHIFT)) {
        throw new Error("Encountered a disabled opcode");
      }

      if (exec && Buffer.isBuffer(opcode))
        this.stack.push(opcode);
      else if (exec || (OP_IF <= opcode && opcode <= OP_ENDIF))
      switch (opcode) {
      case OP_0:
        this.stack.push(new Buffer([]));
        break;

      case OP_1NEGATE:
      case OP_1:
      case OP_2:
      case OP_3:
      case OP_4:
      case OP_5:
      case OP_6:
      case OP_7:
      case OP_8:
      case OP_9:
      case OP_10:
      case OP_11:
      case OP_12:
      case OP_13:
      case OP_14:
      case OP_15:
      case OP_16:
        this.stack.push(bigintToBuffer(opcode - OP_1 + 1));
        break;

      case OP_NOP:
      case OP_NOP1: case OP_NOP2: case OP_NOP3: case OP_NOP4: case OP_NOP5:
      case OP_NOP6: case OP_NOP7: case OP_NOP8: case OP_NOP9: case OP_NOP10:
        break;

      case OP_IF:
      case OP_NOTIF:
        // <expression> if [statements] [else [statements]] endif
        var value = false;
        if (exec) {
          value = castBool(this.stackPop());
          if (opcode == OP_NOTIF) {
            value = !value;
          }
        }
        execStack.push(value);
        break;

      case OP_ELSE:
        if (execStack.length < 1) {
          throw new Error("Unmatched OP_ELSE");
        }
        execStack[execStack.length-1] = !execStack[execStack.length-1];
        break;

      case OP_ENDIF:
        if (execStack.length < 1) {
          throw new Error("Unmatched OP_ENDIF");
        }
        execStack.pop();
        break;

      case OP_VERIFY:
        var value = castBool(this.stackTop());
        if (value) {
          this.stackPop();
        } else {
          return false;
        }
        break;

      case OP_RETURN:
        return false;

      case OP_TOALTSTACK:
        altStack.push(this.stackPop());
        break;

      case OP_FROMALTSTACK:
        if (altStack.length < 1) {
          throw new Error("OP_FROMALTSTACK with alt stack empty");
        }
        this.stack.push(altStack.pop());
        break;

      case OP_2DROP:
        // (x1 x2 -- )
        this.stackPop();
        this.stackPop();
        break;

      case OP_2DUP:
        // (x1 x2 -- x1 x2 x1 x2)
        var v1 = this.stackTop(2);
        var v2 = this.stackTop(1);
        this.stack.push(v1);
        this.stack.push(v2);
        break;

      case OP_3DUP:
        // (x1 x2 -- x1 x2 x1 x2)
        var v1 = this.stackTop(3);
        var v2 = this.stackTop(2);
        var v3 = this.stackTop(1);
        this.stack.push(v1);
        this.stack.push(v2);
        this.stack.push(v3);
        break;

      case OP_2OVER:
        // (x1 x2 x3 x4 -- x1 x2 x3 x4 x1 x2)
        var v1 = this.stackTop(4);
        var v2 = this.stackTop(3);
        this.stack.push(v1);
        this.stack.push(v2);
        break;

      case OP_2ROT:
        // (x1 x2 x3 x4 x5 x6 -- x3 x4 x5 x6 x1 x2)
        var v1 = this.stackTop(6);
        var v2 = this.stackTop(5);
        this.stack.splice(this.stack.length - 6, 2);
        this.stack.push(v1);
        this.stack.push(v2);
        break;

      case OP_2SWAP:
        // (x1 x2 x3 x4 -- x3 x4 x1 x2)
        this.stackSwap(4, 2);
        this.stackSwap(3, 1);
        break;

      case OP_IFDUP:
        // (x - 0 | x x)
        var value = this.stackTop();
        if (castBool(value)) {
          this.stack.push(value);
        }
        break;

      case OP_DEPTH:
        // -- stacksize
        var value = bigint(this.stack.length);
        this.stack.push(bigintToBuffer(value));
        break;

      case OP_DROP:
        // (x -- )
        this.stackPop();
        break;

      case OP_DUP:
        // (x -- x x)
        this.stack.push(this.stackTop());
        break;

      case OP_NIP:
        // (x1 x2 -- x2)
        if (this.stack.length < 2) {
          throw new Error("OP_NIP insufficient stack size");
        }
        this.stack.splice(this.stack.length - 2, 1);
        break;

      case OP_OVER:
        // (x1 x2 -- x1 x2 x1)
        this.stack.push(this.stackTop(2));
        break;

      case OP_PICK:
      case OP_ROLL:
        // (xn ... x2 x1 x0 n - xn ... x2 x1 x0 xn)
        // (xn ... x2 x1 x0 n - ... x2 x1 x0 xn)
        var n = castInt(this.stackPop());
        if (n < 0 || n >= this.stack.length) {
          throw new Error("OP_PICK/OP_ROLL insufficient stack size");
        }
        var value = this.stackTop(n+1);
        if (opcode == OP_ROLL) {
          this.stack.splice(this.stack.length - n - 1, 1);
        }
        this.stack.push(value);
        break;

      case OP_ROT:
        // (x1 x2 x3 -- x2 x3 x1)
        //  x2 x1 x3  after first swap
        //  x2 x3 x1  after second swap
        this.stackSwap(3, 2);
        this.stackSwap(2, 1);
        break;

      case OP_SWAP:
        // (x1 x2 -- x2 x1)
        this.stackSwap(2, 1);
        break;

      case OP_TUCK:
        // (x1 x2 -- x2 x1 x2)
        if (this.stack.length < 2) {
          throw new Error("OP_TUCK insufficient stack size");
        }
        this.stack.splice(this.stack.length - 2, 0, this.stackTop());
        break;

      case OP_CAT:
        // (x1 x2 -- out)
        var v1 = this.stackTop(2);
        var v2 = this.stackTop(1);
        this.stackPop();
        this.stackPop();
        this.stack.push(v1.concat(v2));
        break;

      case OP_SUBSTR:
        // (in begin size -- out)
        var buf = this.stackTop(3);
        var start = castInt(this.stackTop(2));
        var len = castInt(this.stackTop(1));
        if (start < 0 || len < 0) {
          throw new Error("OP_SUBSTR start < 0 or len < 0");
        }
        if ((start + len) >= buf.length) {
          throw new Error("OP_SUBSTR range out of bounds");
        }
        this.stackPop();
        this.stackPop();
        this.stack[this.stack.length-1] = buf.slice(start, start + len);
        break;

      case OP_LEFT:
      case OP_RIGHT:
        // (in size -- out)
        var buf = this.stackTop(2);
        var size = castInt(this.stackTop(1));
        if (size < 0) {
          throw new Error("OP_LEFT/OP_RIGHT size < 0");
        }
        if (size > buf.length) {
          size = buf.length;
        }
        this.stackPop();
        if (opcode == OP_LEFT) {
          this.stack[this.stack.length-1] = buf.slice(0, size);
        } else {
          this.stack[this.stack.length-1] = buf.slice(buf.length - size);
        }
        break;

      case OP_SIZE:
        // (in -- in size)
        var value = bigint(this.stackTop().length);
        this.stack.push(bigintToBuffer(value));
        break;

      case OP_INVERT:
        // (in - out)
        var buf = this.stackTop();
        for (var i = 0, l = buf.length; i < l; i++) {
          buf[i] = ~buf[i];
        }
        break;

      case OP_AND:
      case OP_OR:
      case OP_XOR:
        // (x1 x2 - out)
        var v1 = this.stackTop(2);
        var v2 = this.stackTop(1);
        this.stackPop();
        this.stackPop();
        var out = new Buffer(Math.max(v1.length, v2.length));
        if (opcode == OP_AND) {
          for (var i = 0, l = out.length; i < l; i++) {
            out[i] = v1[i] & v2[i];
          }
        } else if (opcode == OP_OR) {
          for (var i = 0, l = out.length; i < l; i++) {
            out[i] = v1[i] | v2[i];
          }
        } else if (opcode == OP_XOR) {
          for (var i = 0, l = out.length; i < l; i++) {
            out[i] = v1[i] ^ v2[i];
          }
        }
        this.stack.push(out);
        break;

      case OP_EQUAL:
      case OP_EQUALVERIFY:
      //case OP_NOTEQUAL: // use OP_NUMNOTEQUAL
        // (x1 x2 - bool)
        var v1 = this.stackTop(2);
        var v2 = this.stackTop(1);
        var value = v1.compare(v2) == 0;

        // OP_NOTEQUAL is disabled because it would be too easy to say
        // something like n != 1 and have some wiseguy pass in 1 with extra
        // zero bytes after it (numerically, 0x01 == 0x0001 == 0x000001)
        //if (opcode == OP_NOTEQUAL)
        //    fEqual = !fEqual;

        this.stackPop();
        this.stackPop();
        this.stack.push(new Buffer([value ? 1 : 0]));
        if (opcode == OP_EQUALVERIFY) {
          if (value) {
            this.stackPop();
          } else {
            return false;
          }
        }
        break;

      case OP_1ADD:
      case OP_1SUB:
      case OP_2MUL:
      case OP_2DIV:
      case OP_NEGATE:
      case OP_ABS:
      case OP_NOT:
      case OP_0NOTEQUAL:
        // (in -- out)
        var num = castBigint(this.stackTop());
        switch (opcode) {
        case OP_1ADD:      num = num.add(bigint(1)); break;
        case OP_1SUB:      num = num.sub(bigint(1)); break;
        case OP_2MUL:      num = num.mul(bigint(2)); break;
        case OP_2DIV:      num = num.div(bigint(2)); break;
        case OP_NEGATE:    num = num.neg(); break;
        case OP_ABS:       num = num.abs(); break;
        case OP_NOT:       num = bigint(num.cmp(0) == 0 ? 1 : 0); break;
        case OP_0NOTEQUAL: num = bigint(num.cmp(0) == 0 ? 0 : 1); break;
        }
        this.stack[this.stack.length-1] = bigintToBuffer(num);
        break;

      case OP_ADD:
      case OP_SUB:
      case OP_MUL:
      case OP_DIV:
      case OP_MOD:
      case OP_LSHIFT:
      case OP_RSHIFT:
      case OP_BOOLAND:
      case OP_BOOLOR:
      case OP_NUMEQUAL:
      case OP_NUMEQUALVERIFY:
      case OP_NUMNOTEQUAL:
      case OP_LESSTHAN:
      case OP_GREATERTHAN:
      case OP_LESSTHANOREQUAL:
      case OP_GREATERTHANOREQUAL:
      case OP_MIN:
      case OP_MAX:
        // (x1 x2 -- out)
        var v1 = castBigint(this.stackTop(2));
        var v2 = castBigint(this.stackTop(1));
        var num;
        switch (opcode) {
        case OP_ADD: num = v1.add(v2); break;
        case OP_SUB: num = v1.sub(v2); break;
        case OP_MUL: num = v1.mul(v2); break;
        case OP_DIV: num = v1.div(v2); break;
        case OP_MOD: num = v1.mod(v2); break;

        case OP_LSHIFT:
          if (v2.cmp(0) < 0 || v2.cmp(2048) > 0) {
            throw new Error("OP_LSHIFT parameter out of bounds");
          }
          num = v1.shiftLeft(v2);
          break;

        case OP_RSHIFT:
          if (v2.cmp(0) < 0 || v2.cmp(2048) > 0) {
            throw new Error("OP_RSHIFT parameter out of bounds");
          }
          num = v1.shiftRight(v2);
          break;

        case OP_BOOLAND:
          num = bigint((v1.cmp(0) != 0 && v2.cmp(0) != 0) ? 1 : 0);
          break;

        case OP_BOOLOR:
          num = bigint((v1.cmp(0) != 0 || v2.cmp(0) != 0) ? 1 : 0);
          break;

        case OP_NUMEQUAL:
        case OP_NUMEQUALVERIFY:
          num = bigint(v1.cmp(v2) == 0 ? 1 : 0);
          break;

        case OP_NUMNOTEQUAL:;
          num = bigint(v1.cmp(v2) != 0 ? 1 : 0);
          break;

        case OP_LESSTHAN:
          num = bigint(v1.lt(v2) ? 1 : 0);
          break;

        case OP_GREATERTHAN:
          num = bigint(v1.gt(v2) ? 1 : 0);
          break;

        case OP_LESSTHANOREQUAL:
          num = bigint(v1.gt(v2) ? 0 : 1);
          break;

        case OP_GREATERTHANOREQUAL:
          num = bigint(v1.lt(v2) ? 0 : 1);
          break;

        case OP_MIN: num = (v1.lt(v2) ? v1 : v2); break;
        case OP_MAX: num = (v1.gt(v2) ? v1 : v2); break;
        }
        this.stackPop();
        this.stackPop();
        this.stack.push(bigintToBuffer(num));

        if (opcode == OP_NUMEQUALVERIFY) {
          if (castBool(this.stackTop())) {
            this.stackPop();
          } else {
            return false;
          }
        }
        break;

      case OP_WITHIN:
        // (x min max -- out)
        var v1 = castBigint(this.stackTop(3));
        var v2 = castBigint(this.stackTop(2));
        var v3 = castBigint(this.stackTop(1));
        this.stackPop();
        this.stackPop();
        this.stackPop();
        var value = v1.cmp(v2) > 0 && v1.cmp(v3) < 0;
        this.stack.push(bigintToBuffer(value ? 1 : 0));
        break;

      case OP_RIPEMD160:
      case OP_SHA1:
      case OP_SHA256:
      case OP_HASH160:
      case OP_HASH256:
        // (in -- hash)
        var value = this.stackPop();
        var hash;
        if (opcode == OP_RIPEMD160) {
          hash = Util.ripe160(value);
        } else if (opcode == OP_SHA1) {
          hash = Util.sha1(value);
        } else if (opcode == OP_SHA256) {
          hash = Util.sha256(value);
        } else if (opcode == OP_HASH160) {
          hash = Util.sha256ripe160(value);
        } else if (opcode == OP_HASH256) {
          hash = Util.twoSha256(value);
        }
        this.stack.push(hash);
        break;

      case OP_CODESEPARATOR:
        // Hash starts after the code separator
        hashStart = pc;
        break;

      case OP_CHECKSIG:
      case OP_CHECKSIGVERIFY:
        // (sig pubkey -- bool)
        var sig = this.stackTop(2);
        var pubkey = this.stackTop(1);

        // Get the part of this script since the last OP_CODESEPARATOR
        var scriptChunks = script.chunks.slice(hashStart);

        // Convert to binary
        var scriptCode = Script.fromChunks(scriptChunks);

        // Remove signature if present (a signature can't sign itself)
        scriptCode.findAndDelete(sig);

        // Verify signature
        var success = checkSig(sig, pubkey, scriptCode, tx, n, hashType);

        // Update stack
        this.stackPop();
        this.stackPop();
        this.stack.push(new Buffer([success ? 1 : 0]));
        if (opcode == OP_CHECKSIGVERIFY) {
          if (success) {
            this.stackPop();
          } else {
            return false;
          }
        }
        break;

      case OP_CHECKMULTISIG:
      case OP_CHECKMULTISIGVERIFY:
        // ([sig ...] num_of_signatures [pubkey ...] num_of_pubkeys -- bool)
        var keysCount = castInt(this.stackPop());
        if (keysCount < 0 || keysCount > 20) {
          return false;
        }
        var keys = [];
        for (var i = 0, l = keysCount; i < l; i++) {
          keys.push(this.stackPop());
        }
        var sigsCount = castInt(this.stackPop());
        if (sigsCount < 0 || sigsCount > 20) {
          return false;
        }
        var sigs = [];
        for (var i = 0, l = sigsCount; i < l; i++) {
          sigs.push(this.stackPop());
        }
        console.log("WARNING OP_CHECKMULTISIG");
        // TODO
        break;

      default:
        return false;
      }

      // Size limits
      if ((this.stack.length + altStack.length) > 1000) {
        return false;
      }
    }
  } catch (e) {
    logger.scrdbg("Script evaluation ended early: "+
                  (e.message ? e.message : e));
    return false;
  }
};

/**
 * Get the top element of the stack.
 *
 * Using the offset parameter this function can also access lower elements
 * from the stack.
 */
ScriptInterpreter.prototype.stackTop = function stackTop(offset) {
  offset = +offset || 1;
  if (offset < 1) offset = 1;

  if (offset > this.stack.length) {
    throw new Error('ScriptInterpreter.stackTop(): Stack underrun');
  }

  return this.stack[this.stack.length-offset];
};

/**
 * Pop the top element off the stack and return it.
 */
ScriptInterpreter.prototype.stackPop = function stackPop() {
  if (this.stack.length < 1) {
    throw new Error('ScriptInterpreter.stackTop(): Stack underrun');
  }

  return this.stack.pop();
};

ScriptInterpreter.prototype.stackSwap = function stackSwap(a, b) {
  if (this.stack.length < a || this.stack.length < b) {
    throw new Error('ScriptInterpreter.stackTop(): Stack underrun');
  }

  var s = this.stack,
      l = s.length;

  var tmp = s[l - a];
  s[l - a] = s[l - b];
  s[l - b] = tmp;
};

/**
 * Returns a version of the stack with only primitive types.
 *
 * The return value is an array. Any single byte buffer is converted to an
 * integer. Any longer Buffer is converted to a hex string.
 */
ScriptInterpreter.prototype.getPrimitiveStack = function getPrimitiveStack() {
  return this.stack.map(function (entry) {
    if (entry.length > 2) {
      return entry.slice(0).toHex();
    }
    var num = castBigint(entry);
    if (num.cmp(-128) >= 0 && num.cmp(127) <= 0) {
      return num.toNumber();
    } else {
      return entry.slice(0).toHex();
    }
  });
};

var castBool = ScriptInterpreter.castBool = function castBool(v) {
  return castBigint(v).cmp(0) !== 0;
};
var castInt = ScriptInterpreter.castInt = function castInt(v) {
  return castBigint(v).toNumber();
};
var castBigint = ScriptInterpreter.castBigint = function castBigint(v) {
  var w = new Buffer(v.length);
  v.copy(w);
  w.reverse();
  if (v[0] & 0x80) {
    // Negative number (two's complement)
    for (var i = 0, l = w.length; i < l; i++) {
      w[i] = 0xff - w[i];
    }
    return bigint.fromBuffer(w).add(1).neg();
  } else {
    // Positive number
    return bigint.fromBuffer(w);
  }
};
var bigintToBuffer = ScriptInterpreter.bigintToBuffer = function bigintToBuffer(v) {
  if ("number" === typeof v) {
    v = bigint(v);
  }
  var buffer = v.toBuffer("mpint");
  if (buffer.length < 4) {
    return new Buffer(0);
  }
  return buffer.slice(4).reverse();
};

ScriptInterpreter.prototype.getResult = function getResult() {
  if (this.stack.length == 0)
    throw new Error("Empty stack after script evaluation");

  return castBool(this.stack.shift());
};

ScriptInterpreter.verify =
function verify(scriptSig, scriptPubKey, txTo, n, hashType) {
  // TODO: Implement

  // Create execution environment
  var si = new ScriptInterpreter();

  // Evaluate scriptSig
  si.eval(scriptSig, txTo, n, hashType);

  // Evaluate scriptPubKey
  si.eval(scriptPubKey, txTo, n, hashType);

  // Check stack
  return si.getResult();
};

var checkSig = ScriptInterpreter.checkSig =
function (sig, pubkey, scriptCode, tx, n, hashType) {
  if (!sig.length) {
    return false;
  }

  if (hashType == 0) {
    hashType = sig.pop();
  } else if (hashType != sig[sig.length -1]) {
    return false;
  }
  sig = sig.slice(0, sig.length-1);

  // Signature verification requires a special hash procedure
  var hash = tx.hashForSignature(scriptCode, n, hashType);

  // Verify signature
  return Util.verifySig(sig, pubkey, hash);
};
