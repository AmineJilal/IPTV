with open('server.js', 'r') as f:
    lines = f.readlines()

out = []
for line in lines:
    if line.startswith("});3')) tdtId = 'Antena3.TV';"):
        out.append("});\n")
        break
    out.append(line)

with open('server.js', 'w') as f:
    f.writelines(out)
