package blockchain

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"math/big"
	"strings"

	"golang.org/x/crypto/sha3"
)

// Keccak256 computes the Keccak-256 hash of input.
func Keccak256(data ...[]byte) []byte {
	h := sha3.NewLegacyKeccak256()
	for _, d := range data {
		h.Write(d)
	}
	return h.Sum(nil)
}

// Keccak256Hash returns hex string with 0x prefix.
func Keccak256Hash(data ...[]byte) string {
	return "0x" + hex.EncodeToString(Keccak256(data...))
}

// FuncSelector returns the 4-byte function selector from its signature.
func FuncSelector(sig string) []byte {
	hash := Keccak256([]byte(sig))
	return hash[:4]
}

// EncodeUint256 encodes a *big.Int as 32-byte padded big-endian.
func EncodeUint256(v *big.Int) []byte {
	b := make([]byte, 32)
	if v != nil {
		blob := v.Bytes()
		if len(blob) > 32 {
			blob = blob[len(blob)-32:]
		}
		copy(b[32-len(blob):], blob)
	}
	return b
}

// EncodeAddress encodes an address (strip 0x if present).
func EncodeAddress(addr string) []byte {
	a := strings.TrimPrefix(addr, "0x")
	if len(a) < 40 {
		a = strings.Repeat("0", 40-len(a)) + a
	}
	b, _ := hex.DecodeString(a)
	return b
}

// EncodeBool encodes a bool as 32 bytes (1 or 0 padded right).
func EncodeBool(v bool) []byte {
	b := make([]byte, 32)
	if v {
		b[31] = 1
	}
	return b
}

// EncodeString encodes a Solidity string.
// Solidity string ABI: offset (32) + length (32) + data (padded to 32-byte boundary).
func EncodeString(s string) []byte {
	data := []byte(s)
	// data length in words (32-byte units)
	dlen := (len(data) + 31) / 32
	padded := dlen * 32
	buf := make([]byte, 0, 64+padded)
	// offset to data
	buf = append(buf, EncodeUint256(big.NewInt(32))...)
	// length
	buf = append(buf, EncodeUint256(big.NewInt(int64(len(data))))...)
	// data padded
	buf = append(buf, data...)
	for len(buf) < 64+padded {
		buf = append(buf, 0)
	}
	return buf
}

// EncodeBytes32 encodes a [32]byte value.
func EncodeBytes32(b [32]byte) []byte {
	return b[:]
}

// MintTicketSig returns the selector + encoded args for TicketNFT.mintTicket.
// Signature: mintTicket(address to, bytes32 eventId, uint256 seatNumber,
//
//	uint256 faceValue, bool kycRequired, string memory metadataURI)
func MintTicketSig(to string, eventID [32]byte, seatNumber uint64, faceValue *big.Int, kycRequired bool, metadataURI string) []byte {
	selector := FuncSelector("mintTicket(address,bytes32,uint256,uint256,bool,string)")
	calldata := make([]byte, 0, 4+32+32+32+32+32+len(EncodeString(metadataURI)))
	calldata = append(calldata, selector...)
	calldata = append(calldata, EncodeAddress(to)...)
	calldata = append(calldata, EncodeBytes32(eventID)...)
	calldata = append(calldata, EncodeUint256(big.NewInt(int64(seatNumber)))...)
	calldata = append(calldata, EncodeUint256(faceValue)...)
	calldata = append(calldata, EncodeBool(kycRequired)...)
	calldata = append(calldata, EncodeString(metadataURI)...)
	return calldata
}

// GetMaxResalePriceSig selector for reading.
func GetMaxResalePriceSig() []byte {
	return FuncSelector("getMaxResalePrice(uint256)")
}

// ponytail: non-critical uint256 underflow protection via contract-level require.
func parseHexInt64(s string) (int64, error) {
	s = strings.TrimPrefix(s, "0x")
	b, err := hex.DecodeString(s)
	if err != nil {
		return 0, err
	}
	n := new(big.Int).SetBytes(b)
	return n.Int64(), nil
}

func parseHexUint64(s string) (uint64, error) {
	s = strings.TrimPrefix(s, "0x")
	b, err := hex.DecodeString(s)
	if err != nil {
		return 0, err
	}
	n := new(big.Int).SetBytes(b)
	return n.Uint64(), nil
}

func init() {
	// Verify selector computation at startup.
	sel := FuncSelector("mintTicket(address,bytes32,uint256,uint256,bool,string)")
	if len(sel) != 4 {
		panic(fmt.Sprintf("selector wrong len: %v", sel))
	}
	// Force sha256 import usage to avoid unused import error
	_ = sha256.Sum224(nil)
}
