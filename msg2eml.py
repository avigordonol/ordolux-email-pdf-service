#!/usr/bin/env python3
# Convert a .msg file to .eml using extract_msg
# Usage: python3 msg2eml.py input.msg output.eml

import sys
from extract_msg import Message
from email.generator import BytesGenerator

def main():
    if len(sys.argv) != 3:
        sys.stderr.write("usage: msg2eml.py <input.msg> <output.eml>\n")
        sys.exit(2)
    src = sys.argv[1]
    dst = sys.argv[2]
    try:
        msg = Message(src)
        eml = msg.as_email()
        with open(dst, 'wb') as f:
            BytesGenerator(f, maxheaderlen=78).flatten(eml)
    except Exception as e:
        sys.stderr.write("error: %s\n" % (str(e)))
        sys.exit(1)

if __name__ == "__main__":
    main()
