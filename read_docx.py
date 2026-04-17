import zipfile
import xml.etree.ElementTree as ET
import sys
import os

def read_docx(file_path):
    try:
        with zipfile.ZipFile(file_path) as docx:
            xml_content = docx.read('word/document.xml')
            tree = ET.fromstring(xml_content)
            
            # The namespace dictionary
            namespaces = {'w': 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'}
            
            # Extract text from all Paragraphs
            paragraphs = []
            for p in tree.findall('.//w:p', namespaces):
                texts = [node.text
                         for node in p.findall('.//w:t', namespaces)
                         if node.text]
                if texts:
                    paragraphs.append(''.join(texts))
            return '\n'.join(paragraphs)
    except Exception as e:
        return str(e)

if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("Usage: python read_docx.py <input.docx> <output.txt>")
        sys.exit(1)
    
    input_file = sys.argv[1]
    output_file = sys.argv[2]
    
    if not os.path.exists(input_file):
        print(f"Error: {input_file} not found.")
        sys.exit(1)
        
    text = read_docx(input_file)
    with open(output_file, 'w', encoding='utf-8') as f:
        f.write(text)
    print(f"Extraction complete: {output_file}")
