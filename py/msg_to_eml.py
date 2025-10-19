# py/msg_to_eml.py
import sys, email, tempfile
import extract_msg

def main():
    data = sys.stdin.buffer.read()
    with tempfile.NamedTemporaryFile(suffix=".msg", delete=True) as f:
        f.write(data); f.flush()
        m = extract_msg.Message(f.name)
        em = m.get_email_message()  # email.message.Message
        sys.stdout.buffer.write(em.as_bytes(policy=email.policy.default))

if __name__ == "__main__":
    main()
